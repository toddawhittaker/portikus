import { z } from "zod";
import { ChangePasswordRequest } from "./auth.js";

/**
 * `POST /auth/password-reset`: ask for an emailed reset link (SPEC.md
 * section 5.3). The answer is the same 202 whether or not the login is an
 * account, so it reveals nothing.
 */
export const PasswordResetRequest = z
	.object({ login: z.string().min(1).max(320) })
	.strict();
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

/**
 * `POST /auth/password-reset/complete`: the token from the link's fragment
 * and the new password, under the same rules as a password change.
 */
export const PasswordResetComplete = z
	.object({
		token: z.string().min(1).max(128),
		password: ChangePasswordRequest.shape.newPassword,
	})
	.strict();
export type PasswordResetComplete = z.infer<typeof PasswordResetComplete>;
