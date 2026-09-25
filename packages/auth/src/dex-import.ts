/**
 * The one-time import of the retired users file into Dex's storage
 * (docs/EPIC-14.md ruling 23, ADR 0028). Every entry keeps its bcrypt hash
 * and user ID, so its subject, and so its Portikus account and workspace,
 * stay the same. A password made through the gRPC API carries no groups, so
 * an instructor or administrator in the file becomes that account's
 * `granted_role`. The import runs at most once per site, and never into a
 * Dex that already holds passwords.
 */
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { DexApi } from "./dex-api.js";
import { dexLocalSubject } from "./dex-subject.js";
import { grantAdministrator, grantInstructor, precreateDexAccount } from "./links.js";

export interface ImportedUser {
	username: string;
	email: string;
	displayName: string;
	userId: string;
	passwordHash: string;
	role: "student" | "instructor" | "administrator";
}

export type DexImportReport =
	| { status: "already_imported"; at: string }
	| { status: "skipped"; passwordsInDex: number }
	| {
			status: "imported";
			usernames: string[];
			granted: string[];
			precreated: string[];
	  };

const ACTOR = "operator:dex-import";
/** The audit row that marks the import as done for this site, for good. */
const IMPORTED = "dex.users_imported";

async function importedAt(db: Kysely<Database>): Promise<string | null> {
	const row = await db
		.selectFrom("audit_events")
		.select("at")
		.where("action", "=", IMPORTED)
		.where("result", "=", "ok")
		.orderBy("id")
		.executeTakeFirst();
	return row ? new Date(row.at).toISOString() : null;
}
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
 * account first when they have never signed in. A disabled account is left
 * alone. Returns what it did.
 */
async function grant(
	trx: Kysely<Database>,
	issuer: string,
	user: ImportedUser & { role: "instructor" | "administrator" },
): Promise<"granted" | "precreated" | "unchanged"> {
	const row = await trx
		.selectFrom("users")
		.select(["id", "granted_role", "disabled_at"])
		.where("oidc_issuer", "=", issuer)
		.where("oidc_subject", "=", dexLocalSubject(user.userId))
		.forUpdate()
		.executeTakeFirst();
	if (!row) {
		const id = await precreateDexAccount(trx, issuer, {
			userId: user.userId,
			email: user.email,
			username: user.username,
			displayName: user.displayName,
			role: user.role,
		});
		await audit(trx, id, { from: null, to: user.role });
		return "precreated";
	}
	// An administrator grant is never lowered to instructor.
	if (
		row.disabled_at !== null ||
		row.granted_role === user.role ||
		row.granted_role === "administrator"
	) {
		return "unchanged";
	}
	const result =
		user.role === "administrator"
			? await grantAdministrator(trx, row.id)
			: await grantInstructor(trx, row.id);
	if (!result.ok) return "unchanged";
	if (!result.changed) {
		// Already that role from the file's groups, which Dex will not send: keep it as a grant.
		await trx
			.updateTable("users")
			.set({ granted_role: user.role, updated_at: new Date().toISOString() })
			.where("id", "=", row.id)
			.execute();
	}
	await audit(trx, row.id, { from: result.from, to: result.to });
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
 * or nothing, and at most once per site: the run that succeeds writes an
 * audit row with its grants, and every later run stops at that row, so an
 * administrator who removes every Dex user does not bring the file back.
 * A failure deletes the passwords this run created and rolls the grants
 * back, so the next run starts again from an empty Dex.
 */
export async function importUsersFile(
	db: Kysely<Database>,
	dex: DexApi,
	issuer: string,
	users: ImportedUser[],
): Promise<DexImportReport> {
	const at = await importedAt(db);
	if (at !== null) return { status: "already_imported", at };
	const existing = await dex.listPasswords();
	if (existing.length > 0) {
		// Mark the site imported too, so a Dex emptied later never gets the file.
		return await db.transaction().execute(async (trx) => {
			await sql`select pg_advisory_xact_lock(hashtext(${IMPORTED}))`.execute(trx);
			const done = await importedAt(trx);
			if (done !== null) return { status: "already_imported", at: done } as const;
			await trx
				.insertInto("audit_events")
				.values({
					actor: ACTOR,
					target: "dex",
					action: IMPORTED,
					result: "ok",
					metadata: JSON.stringify({ skipped: true, passwordsInDex: existing.length }),
				})
				.execute();
			return { status: "skipped", passwordsInDex: existing.length } as const;
		});
	}

	const created: ImportedUser[] = [];
	try {
		return await db.transaction().execute(async (trx) => {
			// One import at a time; the second waits here, then sees the marker.
			await sql`select pg_advisory_xact_lock(hashtext(${IMPORTED}))`.execute(trx);
			const done = await importedAt(trx);
			if (done !== null) return { status: "already_imported", at: done } as const;
			const granted: string[] = [];
			const precreated: string[] = [];
			for (const user of users) {
				if (user.role === "student") continue;
				const result = await grant(trx, issuer, { ...user, role: user.role });
				if (result === "granted") granted.push(user.username);
				if (result === "precreated") precreated.push(user.username);
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
				created.push(user);
			}
			await trx
				.insertInto("audit_events")
				.values({
					actor: ACTOR,
					target: "dex",
					action: IMPORTED,
					result: "ok",
					metadata: JSON.stringify({ users: users.length }),
				})
				.execute();
			return {
				status: "imported",
				usernames: users.map((u) => u.username),
				granted,
				precreated,
			} as const;
		});
	} catch (err) {
		const leftBehind: string[] = [];
		for (const user of created) {
			await dex.deletePassword(user.email).catch(() => {
				leftBehind.push(user.username);
			});
		}
		if (leftBehind.length === 0) throw err;
		throw new Error(
			`${err instanceof Error ? err.message : String(err)}; ` +
				`could not remove these Dex passwords again, delete them before the next run: ${leftBehind.join(", ")}`,
			{ cause: err },
		);
	}
}

/** The plain-text report the command prints: usernames only. */
export function formatImportReport(report: DexImportReport): string {
	if (report.status === "already_imported") {
		return `The users file was already imported on ${report.at}; it is retired and nothing was imported.\n`;
	}
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
