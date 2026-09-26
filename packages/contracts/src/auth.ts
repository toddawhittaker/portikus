import { z } from "zod";

/** Platform roles (SPEC.md §5.2; `instructor` from docs/archive/epics/EPIC-13.md ruling 4). */
export const Role = z.enum(["student", "instructor", "administrator"]);
export type Role = z.infer<typeof Role>;

/** The signed-in user as the API describes them (SPEC.md §5.1, §5.2). */
export const AuthUser = z.object({
	id: z.string().uuid(),
	email: z.string().nullable(),
	displayName: z.string().min(1),
	role: Role,
	/**
	 * The name the user signs in with: the username, or the identity
	 * provider's subject when it sends none. `GET /auth/me` always sends
	 * it. Optional so a caller that only has the session user still parses.
	 */
	signInName: z.string().min(1).optional(),
	/**
	 * While true the account can use only the change-password page
	 * (SPEC.md section 5.3).
	 */
	mustChangePassword: z.boolean(),
	/**
	 * While true the account can use only the acceptable-use page
	 * (docs/EPIC-14-3.md ruling 32).
	 */
	mustAcceptUse: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUser>;

/** Response body for `GET /auth/me`. */
export const MeResponse = AuthUser.extend({
	/** The account is a Dex local password, so Settings offers Password. */
	localPassword: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** bcrypt, which Dex uses, reads at most 72 bytes. */
const BCRYPT_MAX_BYTES = 72;

/**
 * `POST /me/password` (SPEC.md section 5.3). At least 15 characters
 * (NIST SP 800-63B revision 4 for a single factor), no composition rules.
 */
export const ChangePasswordRequest = z
	.object({
		currentPassword: z.string().min(1).max(1024),
		newPassword: z
			.string()
			// Characters as people count them: code points, not UTF-16 units.
			.refine((p) => [...p].length >= 15, "Use at least 15 characters")
			.refine(
				(p) => new TextEncoder().encode(p).length <= BCRYPT_MAX_BYTES,
				"Use at most 72 bytes",
			),
	})
	.strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** `GET /me/acceptable-use`: the statement to accept and its version (ruling 33). */
export const AcceptableUseResponse = z.object({
	text: z.string(),
	version: z.number().int().positive(),
});
export type AcceptableUseResponse = z.infer<typeof AcceptableUseResponse>;

/** `POST /me/acceptable-use`: the version the person was shown. */
export const AcceptUseRequest = z
	.object({ version: z.number().int().positive() })
	.strict();
export type AcceptUseRequest = z.infer<typeof AcceptUseRequest>;
