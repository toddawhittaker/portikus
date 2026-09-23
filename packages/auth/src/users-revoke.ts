/**
 * Ends the Portikus sessions of Dex accounts that `make users-deploy` took
 * away or weakened: removed, given a new password, or demoted. Dex alone
 * would let those sessions run until they expire. Ansible passes the users
 * it deployed last time and the users it deploys now, with a fingerprint of
 * each password hash instead of the hash itself.
 */
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { dexLocalSubject } from "./dex-subject.js";

export interface DeployedUser {
	username: string;
	userId: string;
	role: string;
	/** A SHA-256 of the bcrypt hash, so a new password shows as a change. */
	passwordFingerprint: string;
}

export interface UsersRevokeInput {
	issuer: string;
	/** Null on the first deploy, when there is nothing to compare with. */
	previous: DeployedUser[] | null;
	next: DeployedUser[];
}

export interface UsersRevokeReport {
	usernames: string[];
	sessionsRevoked: number;
}

const ACTOR = "operator:users-deploy";

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`${what} must be a non-empty string`);
	}
	return value;
}

function parseUsers(value: unknown, what: string): DeployedUser[] {
	if (!Array.isArray(value)) throw new Error(`${what} must be a list`);
	return value.map((u: unknown, i) => {
		if (typeof u !== "object" || u === null) {
			throw new Error(`${what}[${i}] must be an object`);
		}
		const entry = u as Record<string, unknown>;
		return {
			username: text(entry.username, `${what}[${i}].username`),
			userId: text(entry.userId, `${what}[${i}].userId`),
			role: text(entry.role, `${what}[${i}].role`),
			passwordFingerprint: text(
				entry.passwordFingerprint,
				`${what}[${i}].passwordFingerprint`,
			),
		};
	});
}

/** Validate the JSON Ansible writes; throws with a message naming the problem. */
export function parseUsersRevokeInput(raw: unknown): UsersRevokeInput {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("input must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	return {
		issuer: text(obj.issuer, "issuer"),
		previous: obj.previous === null ? null : parseUsers(obj.previous, "previous"),
		next: parseUsers(obj.next, "next"),
	};
}

/** The previously deployed users who were removed, got a new password, or changed role. */
export function usersToRevoke(
	previous: DeployedUser[],
	next: DeployedUser[],
): DeployedUser[] {
	// Dex keys a session's subject on userId, so that is the identity here.
	const now = new Map(next.map((u) => [u.userId, u]));
	return previous.filter((before) => {
		const after = now.get(before.userId);
		if (!after) return true;
		if (after.passwordFingerprint !== before.passwordFingerprint) return true;
		// The users row keeps the role from the last sign-in, so a changed role needs a new sign-in.
		return after.role !== before.role;
	});
}

/** Delete the sessions and preview sessions of those users, with one audit row. */
export async function revokeDeployedUsers(
	db: Kysely<Database>,
	input: UsersRevokeInput,
): Promise<UsersRevokeReport> {
	if (input.previous === null) return { usernames: [], sessionsRevoked: 0 };
	const users = usersToRevoke(input.previous, input.next);
	if (users.length === 0) return { usernames: [], sessionsRevoked: 0 };
	const usernames = users.map((u) => u.username);
	const subjects = users.map((u) => dexLocalSubject(u.userId));
	return db.transaction().execute(async (trx) => {
		const rows = await trx
			.selectFrom("users")
			.select("id")
			.where("oidc_issuer", "=", input.issuer)
			.where("oidc_subject", "in", subjects)
			.execute();
		const ids = rows.map((r) => r.id);
		let sessionsRevoked = 0;
		if (ids.length > 0) {
			await trx.deleteFrom("preview_sessions").where("user_id", "in", ids).execute();
			const deleted = await trx
				.deleteFrom("sessions")
				.where("user_id", "in", ids)
				.executeTakeFirst();
			sessionsRevoked = Number(deleted.numDeletedRows);
		}
		await trx
			.insertInto("audit_events")
			.values({
				actor: ACTOR,
				target: "sessions",
				action: "auth.sessions_revoked",
				result: "ok",
				metadata: JSON.stringify({
					reason: "users-deploy",
					usernames,
					count: sessionsRevoked,
				}),
			})
			.execute();
		return { usernames, sessionsRevoked };
	});
}

/** The plain-text report the command prints; usernames and a count only. */
export function formatUsersRevokeReport(report: UsersRevokeReport): string {
	if (report.usernames.length === 0) return "No account lost access.\n";
	return `Sessions ended for: ${report.usernames.join(", ")}\nSessions revoked: ${report.sessionsRevoked}\n`;
}
