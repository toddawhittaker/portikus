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
});
export type AuthUser = z.infer<typeof AuthUser>;

/** Response body for `GET /auth/me`. */
export const MeResponse = AuthUser;
export type MeResponse = z.infer<typeof MeResponse>;
