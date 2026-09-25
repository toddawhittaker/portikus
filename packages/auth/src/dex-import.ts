/**
 * The one-time import of the retired users file into Dex's storage
 * (docs/EPIC-14.md ruling 23, ADR 0028). Every entry keeps its bcrypt hash
 * and user ID, so its subject, and so its Portikus account and workspace,
 * stay the same. A password made through the gRPC API carries no groups, so
 * an instructor or administrator in the file becomes that account's
 * `granted_role`. Dex holding any password means the import already ran, or
 * the site manages its users in the admin area: nothing is done then.
 */
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { DexApi } from "./dex-api.js";
import { dexLocalSubject } from "./dex-subject.js";

export interface ImportedUser {
	username: string;
	email: string;
	displayName: string;
	userId: string;
	passwordHash: string;
	role: "student" | "instructor" | "administrator";
}

export type DexImportReport =
	| { status: "skipped"; passwordsInDex: number }
	| {
			status: "imported";
			usernames: string[];
			granted: string[];
			precreated: string[];
	  };

const ACTOR = "operator:dex-import";
const ROLES = new Set(["student", "instructor", "administrator"]);

function field(entry: Record<string, unknown>, name: string, i: number): string {
	const value = entry[name];
	if (typeof value !== "string" || value === "") {
		throw new Error(`users[${i}].${name} must be a non-empty string`);
	}
	return value;
}

/** Validate a version 1 users file; throws naming the entry, never a hash. */
export function parseUsersFile(raw: unknown): ImportedUser[] {
	const file = raw as { version?: unknown; users?: unknown } | null;
	if (file?.version !== 1 || !Array.isArray(file.users) || file.users.length === 0) {
		throw new Error("the users file must be version 1 with at least one user");
	}
	return file.users.map((u: Record<string, unknown>, i) => {
		const role = field(u, "role", i);
		if (!ROLES.has(role)) throw new Error(`users[${i}].role is not a known role`);
		return {
			username: field(u, "username", i),
			email: field(u, "email", i),
			displayName: field(u, "displayName", i),
			userId: field(u, "userId", i),
			passwordHash: field(u, "passwordHash", i),
			role: role as ImportedUser["role"],
		};
	});
}

/**
 * Set the grant on the account Dex will sign this user into, creating the
 * account first when they have never signed in. Returns what it did.
 */
async function grant(
	trx: Kysely<Database>,
	issuer: string,
	user: ImportedUser & { role: "instructor" | "administrator" },
): Promise<"granted" | "precreated" | "unchanged"> {
	const subject = dexLocalSubject(user.userId);
	const row = await trx
		.selectFrom("users")
		.select(["id", "role", "granted_role"])
		.where("oidc_issuer", "=", issuer)
		.where("oidc_subject", "=", subject)
		.forUpdate()
		.executeTakeFirst();
	if (!row) {
		const created = await trx
			.insertInto("users")
			.values({
				oidc_issuer: issuer,
				oidc_subject: subject,
				email: user.email,
				display_name: user.displayName,
				preferred_username: user.username,
				role: user.role,
				provider_role: "student",
				granted_role: user.role,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await audit(trx, created.id, { from: null, to: user.role });
		return "precreated";
	}
	// An administrator grant is never lowered to instructor.
	if (row.granted_role === user.role || row.granted_role === "administrator") {
		return "unchanged";
	}
	const updated = await trx
		.updateTable("users")
		.set({
			granted_role: user.role,
			role: sql<string>`case
				when ${user.role} = 'administrator' or provider_role = 'administrator' then 'administrator'
				else 'instructor' end`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", row.id)
		.returning("role")
		.executeTakeFirstOrThrow();
	await audit(trx, row.id, { from: row.role, to: updated.role });
	return "granted";
}

function audit(
	trx: Kysely<Database>,
	target: string,
	change: { from: string | null; to: string },
) {
	return trx
		.insertInto("audit_events")
		.values({
			actor: ACTOR,
			target,
			action: "user.role_changed",
			result: "ok",
			metadata: JSON.stringify({ ...change, source: "import" }),
		})
		.execute();
}

/**
 * Import every user into an empty Dex, and their grants into Portikus, all
 * or nothing: a failure deletes the passwords this run created and rolls
 * the grants back, so the next run starts again from an empty Dex.
 */
export async function importUsersFile(
	db: Kysely<Database>,
	dex: DexApi,
	issuer: string,
	users: ImportedUser[],
): Promise<DexImportReport> {
	const existing = await dex.listPasswords();
	if (existing.length > 0)
		return { status: "skipped", passwordsInDex: existing.length };

	const created: string[] = [];
	try {
		return await db.transaction().execute(async (trx) => {
			const granted: string[] = [];
			const precreated: string[] = [];
			for (const user of users) {
				if (user.role === "student") continue;
				const done = await grant(trx, issuer, { ...user, role: user.role });
				if (done === "granted") granted.push(user.username);
				if (done === "precreated") precreated.push(user.username);
			}
			for (const user of users) {
				const result = await dex.createPassword({
					email: user.email,
					username: user.username,
					userId: user.userId,
					hash: user.passwordHash,
				});
				if (result === "already_exists") {
					throw new Error(`Dex already has a password for ${user.username}`);
				}
				created.push(user.email);
			}
			return {
				status: "imported",
				usernames: users.map((u) => u.username),
				granted,
				precreated,
			};
		});
	} catch (err) {
		for (const email of created) await dex.deletePassword(email).catch(() => {});
		throw err;
	}
}

/** The plain-text report the command prints: usernames only. */
export function formatImportReport(report: DexImportReport): string {
	if (report.status === "skipped") {
		return `Dex already holds ${report.passwordsInDex} passwords; nothing imported.\n`;
	}
	const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "none");
	return [
		`Imported into Dex: ${list(report.usernames)}`,
		`Grants set: ${list(report.granted)}`,
		`Accounts created for a grant: ${list(report.precreated)}`,
		"",
	].join("\n");
}
