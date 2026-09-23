/**
 * Moves existing Portikus accounts onto their Dex subjects at the cutover
 * from the mock identity provider (docs/EPIC-12B.md, "Carrying existing
 * accounts over"). A dry run unless `apply` is set; safe to run again.
 */
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { dexLocalSubject } from "./dex-subject.js";

export interface CarryOverUser {
	email: string;
	username: string;
	userId: string;
}

export interface CarryOverInput {
	toIssuer: string;
	fromIssuers: string[];
	users: CarryOverUser[];
}

export interface CarryOverOutcome {
	email: string;
	username: string;
	/** linked: already on Dex. carried: row rewritten. new: created at first sign-in. */
	status: "linked" | "carried" | "new";
	rowId?: string;
	fromIssuer?: string;
	/** Other matching rows, left untouched (#302). */
	leftBehind: string[];
}

export interface CarryOverReport {
	applied: boolean;
	users: CarryOverOutcome[];
	sessionsRevoked: number;
}

const ACTOR = "operator:carry-over";

function nonEmptyString(value: unknown, what: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`${what} must be a non-empty string`);
	}
	return value;
}

/** Validate the JSON Ansible writes; throws with a message naming the problem. */
export function parseCarryOverInput(raw: unknown): CarryOverInput {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("input must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	const toIssuer = nonEmptyString(obj.toIssuer, "toIssuer");
	if (!Array.isArray(obj.fromIssuers) || obj.fromIssuers.length === 0) {
		throw new Error("fromIssuers must be a non-empty list");
	}
	const fromIssuers = obj.fromIssuers.map((v, i) =>
		nonEmptyString(v, `fromIssuers[${i}]`),
	);
	if (fromIssuers.includes(toIssuer)) {
		throw new Error("toIssuer must not be one of fromIssuers");
	}
	if (!Array.isArray(obj.users)) {
		throw new Error("users must be a list");
	}
	const emails = new Set<string>();
	const ids = new Set<string>();
	const users = obj.users.map((u: unknown, i) => {
		if (typeof u !== "object" || u === null)
			throw new Error(`users[${i}] must be an object`);
		const entry = u as Record<string, unknown>;
		const user = {
			email: nonEmptyString(entry.email, `users[${i}].email`),
			username: nonEmptyString(entry.username, `users[${i}].username`),
			userId: nonEmptyString(entry.userId, `users[${i}].userId`),
		};
		dexLocalSubject(user.userId);
		const email = user.email.toLowerCase();
		if (emails.has(email))
			throw new Error(`users[${i}]: duplicate email ${user.email}`);
		if (ids.has(user.userId)) throw new Error(`users[${i}]: duplicate userId`);
		emails.add(email);
		ids.add(user.userId);
		return user;
	});
	return { toIssuer, fromIssuers, users };
}

/** Plan the carry-over and, with `apply`, carry it out in one transaction. */
export async function carryOver(
	db: Kysely<Database>,
	input: CarryOverInput,
	options: { apply: boolean },
): Promise<CarryOverReport> {
	return db.transaction().execute(async (trx) => {
		// Checked before any row moves to Dex, so a carried user's old session counts.
		const mockSession = await trx
			.selectFrom("sessions")
			.innerJoin("users", "users.id", "sessions.user_id")
			.select("sessions.id")
			.where("users.oidc_issuer", "in", input.fromIssuers)
			.executeTakeFirst();
		const users: CarryOverOutcome[] = [];
		for (const u of input.users) {
			const subject = dexLocalSubject(u.userId);
			const linked = await trx
				.selectFrom("users")
				.select("id")
				.where("oidc_issuer", "=", input.toIssuer)
				.where("oidc_subject", "=", subject)
				.executeTakeFirst();
			if (linked) {
				users.push({
					email: u.email,
					username: u.username,
					status: "linked",
					rowId: linked.id,
					leftBehind: [],
				});
				continue;
			}
			const candidates = await trx
				.selectFrom("users")
				.select(["id", "oidc_issuer", "last_login_at"])
				.where(sql<string>`lower(email)`, "=", u.email.toLowerCase())
				.where("oidc_issuer", "in", input.fromIssuers)
				.execute();
			if (candidates.length === 0) {
				users.push({
					email: u.email,
					username: u.username,
					status: "new",
					leftBehind: [],
				});
				continue;
			}
			// First issuer in fromIssuers wins, then the newest sign-in.
			candidates.sort((a, b) => {
				const byIssuer =
					input.fromIssuers.indexOf(a.oidc_issuer) -
					input.fromIssuers.indexOf(b.oidc_issuer);
				if (byIssuer !== 0) return byIssuer;
				return (b.last_login_at?.getTime() ?? -1) - (a.last_login_at?.getTime() ?? -1);
			});
			const [chosen, ...rest] = candidates as [
				(typeof candidates)[0],
				...typeof candidates,
			];
			users.push({
				email: u.email,
				username: u.username,
				status: "carried",
				rowId: chosen.id,
				fromIssuer: chosen.oidc_issuer,
				leftBehind: rest.map((r) => r.id),
			});
			if (!options.apply) continue;
			await trx
				.updateTable("users")
				.set({
					oidc_issuer: input.toIssuer,
					oidc_subject: subject,
					updated_at: new Date().toISOString(),
				})
				.where("id", "=", chosen.id)
				.execute();
			await trx
				.insertInto("audit_events")
				.values({
					actor: ACTOR,
					target: chosen.id,
					action: "user.identity_changed",
					result: "ok",
					metadata: JSON.stringify({
						fromIssuer: chosen.oidc_issuer,
						toIssuer: input.toIssuer,
						username: u.username,
					}),
				})
				.execute();
		}

		let sessionsRevoked = 0;
		// While the mock was on, anyone could have made an administrator session.
		// Once no mock-issuer session is left, a re-run leaves Dex sessions alone.
		if (options.apply && mockSession) {
			await trx.deleteFrom("preview_sessions").execute();
			const deleted = await trx.deleteFrom("sessions").executeTakeFirst();
			sessionsRevoked = Number(deleted.numDeletedRows);
			await trx
				.insertInto("audit_events")
				.values({
					actor: ACTOR,
					target: "sessions",
					action: "auth.sessions_revoked",
					result: "ok",
					metadata: JSON.stringify({
						reason: "identity-provider-cutover",
						count: sessionsRevoked,
					}),
				})
				.execute();
		}
		return { applied: options.apply, users, sessionsRevoked };
	});
}

/** The plain-text report the command prints. */
export function formatReport(report: CarryOverReport): string {
	const lines = [
		report.applied ? "Carry-over applied." : "Carry-over dry run: nothing changed.",
	];
	for (const u of report.users) {
		const who = `${u.username} <${u.email}>`;
		if (u.status === "linked") lines.push(`${who}: already linked (row ${u.rowId})`);
		if (u.status === "new") lines.push(`${who}: new user: created at first sign-in`);
		if (u.status === "carried") {
			const verb = report.applied ? "carried" : "would carry";
			lines.push(`${who}: ${verb} row ${u.rowId} from ${u.fromIssuer}`);
		}
		for (const id of u.leftBehind) lines.push(`${who}: left behind (#302) row ${id}`);
	}
	if (report.applied) lines.push(`Sessions revoked: ${report.sessionsRevoked}`);
	return `${lines.join("\n")}\n`;
}
