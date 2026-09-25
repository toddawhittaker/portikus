import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { type DexApi, generateDexPassword, hashDexPassword } from "./dex-api.js";
import { dexLocalSubject } from "./dex-subject.js";
import { precreateDexAccount } from "./links.js";

/**
 * The local administrator every install has (docs/EPIC-14-2.md rulings 10
 * to 19; ADR 0031). Its Dex user ID is a constant, so `reset-admin` can
 * always find both its password and its Portikus account.
 */
export const LOCAL_ADMIN_USER_ID = "local-admin";

/** Exit codes of `reset-admin --if-missing` when the account exists (ruling 19). */
export const EXIT_EXISTS_FLAG_SET = 10;
export const EXIT_EXISTS_FLAG_CLEAR = 11;

/** Dex already holds another password with the email the new one needs. */
export class LocalAdminEmailTaken extends Error {
	constructor() {
		super(
			"another Dex password already uses this email; choose another with --email (portikus_admin_email)",
		);
	}
}

export interface ResetLocalAdminInput {
	db: Kysely<Database>;
	dex: DexApi;
	/** The site's Dex issuer, OIDC_ISSUER_URL. */
	issuer: string;
	/** PUBLIC_URL, for the default email admin@<host>. */
	publicUrl: string;
	email?: string | undefined;
	/** Do nothing when the account exists, even disabled. */
	ifMissing?: boolean;
}

export type ResetLocalAdminResult =
	| { outcome: "created" | "reset"; userId: string; email: string; password: string }
	| { outcome: "exists"; mustChangePassword: boolean };

/**
 * Give the local administrator a new one-time password, restore its
 * administrator grant, re-enable it, set the flag, and end its sessions.
 * The password is returned for the caller to write to the root-only file;
 * it is never logged or audited.
 */
export async function resetLocalAdmin(
	input: ResetLocalAdminInput,
): Promise<ResetLocalAdminResult> {
	const { db, dex, issuer } = input;
	const subject = dexLocalSubject(LOCAL_ADMIN_USER_ID);
	const account = await db
		.selectFrom("users")
		.select(["id", "email", "must_change_password"])
		.where("oidc_issuer", "=", issuer)
		.where("oidc_subject", "=", subject)
		.executeTakeFirst();
	if (account && input.ifMissing) {
		return { outcome: "exists", mustChangePassword: account.must_change_password };
	}

	const existing = (await dex.listPasswords()).find(
		(p) => p.userId === LOCAL_ADMIN_USER_ID,
	);
	const email =
		existing?.email ??
		input.email ??
		account?.email ??
		`admin@${new URL(input.publicUrl).hostname}`;
	const password = generateDexPassword();
	const hash = await hashDexPassword(password);

	const userId = await db.transaction().execute(async (trx) => {
		const now = new Date().toISOString();
		let id: string;
		if (account) {
			id = account.id;
			await trx
				.updateTable("users")
				.set({
					disabled_at: null,
					granted_role: "administrator",
					// The grant is the highest role, so the effective role is too.
					role: "administrator",
					must_change_password: true,
					updated_at: now,
				})
				.where("id", "=", id)
				.execute();
		} else {
			id = await precreateDexAccount(trx, issuer, {
				userId: LOCAL_ADMIN_USER_ID,
				email,
				username: "admin",
				displayName: "Local administrator",
				role: "administrator",
				mustChangePassword: true,
			});
		}
		await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
		await trx
			.updateTable("preview_sessions")
			.set({ revoked_at: now })
			.where("user_id", "=", id)
			.where("revoked_at", "is", null)
			.execute();
		await trx
			.insertInto("audit_events")
			.values({
				actor: "host:root",
				target: id,
				action: account ? "local_admin.reset" : "local_admin.created",
				result: "ok",
				metadata: JSON.stringify({}),
			})
			.execute();
		// Last, so a refusal rolls the account back with it.
		if (existing) {
			await dex.updatePassword(existing.email, hash);
		} else {
			const created = await dex.createPassword({
				email,
				username: "admin",
				userId: LOCAL_ADMIN_USER_ID,
				hash,
			});
			if (created === "already_exists") throw new LocalAdminEmailTaken();
		}
		return id;
	});

	return { outcome: account ? "reset" : "created", userId, email, password };
}

/** Where `runResetAdmin` writes: standard output gets the password and nothing else. */
export interface ResetAdminIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/** What `runResetAdmin` needs from the process, so tests can pass their own. */
export interface ResetAdminDeps {
	db: Kysely<Database>;
	dex: DexApi;
	env: { OIDC_ISSUER_URL?: string | undefined; PUBLIC_URL?: string | undefined };
}

/**
 * The command behind `portikus reset-admin` (ruling 20). Standard output
 * carries only the password, which the caller pipes into the root-only
 * file; every other message goes to standard error. Returns the exit code:
 * 0 with a new password, 10 or 11 when `--if-missing` found the account
 * with the flag set or clear, 1 on failure, 2 for bad arguments.
 */
export async function runResetAdmin(
	args: string[],
	deps: ResetAdminDeps,
	io: ResetAdminIo,
): Promise<number> {
	const parsed = parseResetAdminArgs(args);
	if (typeof parsed === "string") {
		io.stderr(`${parsed}\nusage: reset-admin [--if-missing] [--email <address>]\n`);
		return 2;
	}
	const { OIDC_ISSUER_URL: issuer, PUBLIC_URL: publicUrl } = deps.env;
	if (!issuer || !publicUrl) {
		io.stderr("OIDC_ISSUER_URL and PUBLIC_URL must be set\n");
		return 2;
	}
	try {
		const result = await resetLocalAdmin({
			db: deps.db,
			dex: deps.dex,
			issuer,
			publicUrl,
			email: parsed.email,
			ifMissing: parsed.ifMissing,
		});
		if (result.outcome === "exists") {
			io.stderr("The local administrator exists; nothing changed.\n");
			return result.mustChangePassword ? EXIT_EXISTS_FLAG_SET : EXIT_EXISTS_FLAG_CLEAR;
		}
		io.stdout(`${result.password}\n`);
		io.stderr(`Local administrator ${result.email} ${result.outcome}.\n`);
		return 0;
	} catch (err) {
		if (err instanceof LocalAdminEmailTaken) {
			io.stderr(`${err.message}\n`);
			return 1;
		}
		// The gRPC status only: the failed call carried a password hash.
		const code = (err as { code?: unknown }).code;
		if (typeof code === "number") {
			io.stderr(`Dex could not be reached (gRPC status ${code}).\n`);
			return 1;
		}
		throw err;
	}
}

function parseResetAdminArgs(
	args: string[],
): { ifMissing: boolean; email: string | undefined } | string {
	let ifMissing = false;
	let email: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--if-missing") {
			ifMissing = true;
		} else if (arg === "--email") {
			const value = args[++i];
			if (!value || !/^[^\s@]+@[^\s@]+$/.test(value)) return "--email needs an address";
			email = value.toLowerCase();
		} else {
			return `unknown argument: ${arg}`;
		}
	}
	return { ifMissing, email };
}
