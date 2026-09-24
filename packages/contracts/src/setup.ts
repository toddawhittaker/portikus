import { z } from "zod";

/**
 * The first administrator's setup code (docs/EPIC-14.md rulings 15 to 18).
 */

/** `GET /setup/state`: whether `/setup` offers the first-account form (ruling 18). */
export const SetupState = z.object({ firstAccount: z.boolean() });
export type SetupState = z.infer<typeof SetupState>;

const Code = z.string().trim().min(1).max(64);

/** `POST /setup/claim`: a signed-in account claims the code. */
export const ClaimSetupCodeRequest = z.object({ code: Code }).strict();
export type ClaimSetupCodeRequest = z.infer<typeof ClaimSetupCodeRequest>;

/** `POST /setup/first-account`: the first Dex password and its administrator account. */
export const FirstAccountRequest = z
	.object({
		email: z.string().trim().toLowerCase().email().max(254),
		username: z
			.string()
			.trim()
			.regex(
				/^[A-Za-z0-9._-]{1,64}$/,
				"Use 1 to 64 letters, digits, dots, dashes or underscores",
			),
		// bcrypt reads at most 72 bytes.
		password: z.string().min(12, "Use at least 12 characters").max(72),
		code: Code,
	})
	.strict();
export type FirstAccountRequest = z.infer<typeof FirstAccountRequest>;
