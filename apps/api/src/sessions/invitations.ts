import { dexConnectorId, type Role, type upsertUser } from "@portikus/auth";
import { type Database, recordAudit } from "@portikus/db";
import { type Kysely, sql } from "kysely";

const RANK: Record<Role, number> = { student: 0, instructor: 1, administrator: 2 };

/** The higher of two roles; a provider group can still raise an invited role (SPEC.md §24.11). */
function higher(a: Role, b: Role): Role {
	return RANK[a] >= RANK[b] ? a : b;
}

export interface NewAccountSignIn {
	identity: Parameters<typeof upsertUser>[1];
	/** The role the provider's groups gave. */
	providerRole: Role;
	/** The ID token's `email_verified` claim was true. */
	emailVerified: boolean;
}

/**
 * Create the account for a first sign-in by claiming an active invitation,
 * or return null when there is none: nobody signs themselves up
 * (SPEC.md §24.13). The account stays keyed by issuer and subject (§5.1);
 * the invitation only decides whether it may be made.
 *
 * Which claim must match the invitation depends on the Dex connector in
 * the subject (ADR 0031). Entra sends no `email_verified`, so Dex is told
 * to skip the check and its email claim proves nothing; the user principal
 * name in `preferred_username` is set by the tenant's administrators and
 * unique in the tenant, so an Entra sign-in matches on that alone, against
 * the invitation's username or, without one, its email. An LDAP directory's
 * username is the directory administrator's too, so it may match as well.
 * Every other sign-in matches only a verified email.
 */
export async function claimInvitation(
	db: Kysely<Database>,
	input: NewAccountSignIn,
): Promise<{ userId: string } | null> {
	const { identity, providerRole, emailVerified } = input;
	const connector = dexConnectorId(identity.subject);
	const username = identity.preferredUsername?.trim().toLowerCase() || null;
	const email = emailVerified ? identity.email?.trim().toLowerCase() || null : null;

	return db.transaction().execute(async (trx) => {
		let candidates = trx
			.selectFrom("account_invitations")
			.select("id")
			.where("claimed_at", "is", null)
			.where("revoked_at", "is", null);
		if (connector === "entra") {
			if (!username) return null;
			candidates = candidates.where(
				sql<string>`coalesce(username, email)`,
				"=",
				username,
			);
		} else if (connector === "ldap") {
			if (!username && !email) return null;
			candidates = candidates.where((eb) =>
				eb.or([
					...(username ? [eb("username", "=", username)] : []),
					...(email ? [eb("email", "=", email)] : []),
				]),
			);
		} else {
			if (!email) return null;
			candidates = candidates.where("email", "=", email);
		}
		const candidate = await candidates.orderBy("created_at").executeTakeFirst();
		if (!candidate) return null;

		const now = new Date().toISOString();
		// Rechecked under the row lock, so two sign-ins cannot both claim it.
		const invitation = await trx
			.updateTable("account_invitations")
			.set({ claimed_at: now })
			.where("id", "=", candidate.id)
			.where("claimed_at", "is", null)
			.where("revoked_at", "is", null)
			.returning(["id", "role"])
			.executeTakeFirst();
		if (!invitation) return null;

		const invitedRole = invitation.role as Role;
		const user = await trx
			.insertInto("users")
			.values({
				oidc_issuer: identity.issuer,
				oidc_subject: identity.subject,
				email: identity.email,
				display_name: identity.displayName,
				preferred_username: identity.preferredUsername,
				role: higher(invitedRole, providerRole),
				provider_role: providerRole,
				// A student invitation grants nothing beyond what every account has.
				granted_role: invitedRole === "student" ? null : invitedRole,
				updated_at: now,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await trx
			.updateTable("account_invitations")
			.set({ claimed_by: user.id })
			.where("id", "=", invitation.id)
			.execute();
		await recordAudit(trx, {
			actor: `user:${user.id}`,
			target: user.id,
			action: "auth.invitation_claimed",
			result: "ok",
			metadata: { invitationId: invitation.id, role: invitedRole },
		});
		return { userId: user.id };
	});
}
