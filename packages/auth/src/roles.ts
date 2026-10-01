import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { isCourseIssuer } from "./links.js";
import type { Role } from "./types.js";

/**
 * Granted roles on top of the provider's role (SPEC.md section 5). Each
 * function runs inside the caller's transaction, so its audit rows commit
 * with it.
 */

export type RoleChange = { from: Role; to: Role };

/**
 * Grant administrator to an SSO account. Run inside the
 * caller's transaction. When the account is already an administrator,
 * `from` equals `to` and nothing is written.
 */
export async function grantAdministrator(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	({ ok: true } & RoleChange) | { ok: false; reason: "not_found" | "course_account" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["oidc_issuer", "role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (isCourseIssuer(target.oidc_issuer))
		return { ok: false, reason: "course_account" };
	const from = target.role as Role;
	if (from === "administrator") return { ok: true, from, to: from };
	const to: Role = "administrator";
	await trx
		.updateTable("users")
		.set({
			granted_role: "administrator",
			role: to,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", targetId)
		.execute();
	return { ok: true, from, to };
}

/**
 * Remove a granted administrator role. Locks the target and every
 * enabled administrator, in id order, so two administrators demoting each
 * other at once cannot both succeed. Run inside the caller's transaction.
 */
export async function revokeAdministrator(
	trx: Kysely<Database>,
	input: { actorId: string; targetId: string },
): Promise<
	| ({ ok: true } & RoleChange)
	| {
			ok: false;
			reason:
				| "not_found"
				| "self"
				| "provider_administrator"
				| "not_administrator"
				| "last_administrator";
	  }
> {
	if (input.actorId === input.targetId) return { ok: false, reason: "self" };
	const locked = await trx
		.selectFrom("users")
		.select(["id", "role", "provider_role", "granted_role", "disabled_at"])
		.where((eb) =>
			eb.or([
				eb("id", "=", input.targetId),
				eb.and([eb("role", "=", "administrator"), eb("disabled_at", "is", null)]),
			]),
		)
		.orderBy("id")
		.forUpdate()
		.execute();
	const target = locked.find((u) => u.id === input.targetId);
	if (!target) return { ok: false, reason: "not_found" };
	if (target.granted_role !== "administrator") {
		const reason =
			target.role === "administrator" ? "provider_administrator" : "not_administrator";
		return { ok: false, reason };
	}
	const others = locked.filter(
		(u) =>
			u.id !== input.targetId && u.role === "administrator" && u.disabled_at === null,
	);
	if (others.length === 0) return { ok: false, reason: "last_administrator" };
	const to = target.provider_role as Role;
	await trx
		.updateTable("users")
		.set({ granted_role: null, role: to, updated_at: new Date().toISOString() })
		.where("id", "=", input.targetId)
		.execute();
	return { ok: true, from: target.role as Role, to };
}

/**
 * Grant instructor to an SSO account (SPEC.md section 5.2). Run inside
 * the caller's transaction. An administrator grant is never touched, and an
 * account already instructor or higher is left as it is (`from` equals `to`).
 */
export async function grantInstructor(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	| ({ ok: true } & RoleChange)
	| { ok: false; reason: "not_found" | "course_account" | "granted_administrator" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["oidc_issuer", "role", "granted_role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (isCourseIssuer(target.oidc_issuer))
		return { ok: false, reason: "course_account" };
	if (target.granted_role === "administrator")
		return { ok: false, reason: "granted_administrator" };
	const from = target.role as Role;
	if (from !== "student") return { ok: true, from, to: from };
	const to: Role = "instructor";
	await trx
		.updateTable("users")
		.set({ granted_role: "instructor", role: to, updated_at: new Date().toISOString() })
		.where("id", "=", targetId)
		.execute();
	return { ok: true, from, to };
}

/**
 * Remove a granted instructor role (SPEC.md section 5.2): the account
 * falls back to its provider role. Only an instructor grant is removed.
 */
export async function revokeInstructor(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	({ ok: true } & RoleChange) | { ok: false; reason: "not_found" | "not_granted" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["role", "provider_role", "granted_role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (target.granted_role !== "instructor") return { ok: false, reason: "not_granted" };
	const to = target.provider_role as Role;
	await trx
		.updateTable("users")
		.set({ granted_role: null, role: to, updated_at: new Date().toISOString() })
		.where("id", "=", targetId)
		.execute();
	return { ok: true, from: target.role as Role, to };
}
