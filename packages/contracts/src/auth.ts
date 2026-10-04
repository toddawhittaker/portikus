import { z } from "zod";

/** Platform roles (SPEC.md §5.2; `instructor` from SPEC.md section 5.2). */
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
	 * (SPEC.md section 5.1).
	 */
	mustAcceptUse: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUser>;

/** Response body for `GET /auth/me`. */
export const MeResponse = AuthUser.extend({
	/** The account is a Dex local password, so Settings offers Password. */
	localPassword: z.boolean(),
	/**
	 * What this session still owes the second-factor check (SPEC.md
	 * section 24.13): enrol a factor, verify one, or nothing.
	 */
	secondFactor: z.enum(["enrol", "verify"]).nullable(),
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

/** `GET /me/acceptable-use`: the statement to accept and its version. */
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

/** One of the account's second factors (SPEC.md section 24.13). */
export const SecondFactor = z.object({
	id: z.string().uuid(),
	kind: z.enum(["totp", "webauthn"]),
	label: z.string(),
	createdAt: z.string(),
	lastUsedAt: z.string().nullable(),
});
export type SecondFactor = z.infer<typeof SecondFactor>;

/** `GET /me/second-factor`. */
export const SecondFactorStatus = z.object({
	factors: z.array(SecondFactor),
	recoveryCodesLeft: z.number().int().nonnegative(),
});
export type SecondFactorStatus = z.infer<typeof SecondFactorStatus>;

/**
 * `POST /me/second-factor/totp/start`: a new secret for the authenticator
 * app, as a QR code and as text, and the token that confirms it.
 */
export const TotpEnrolStart = z.object({
	token: z.string(),
	secret: z.string(),
	uri: z.string(),
	/** The QR code as an SVG data URL. */
	qrCode: z.string(),
});
export type TotpEnrolStart = z.infer<typeof TotpEnrolStart>;

/** A code from the authenticator app: six digits, spaces allowed. */
const TotpCode = z
	.string()
	.transform((code) => code.replace(/\s/g, ""))
	.refine((code) => /^\d{6}$/.test(code), "Enter the 6-digit code");

/** `POST /me/second-factor/totp`: confirm a started enrolment with its first code. */
export const TotpEnrolConfirm = z
	.object({
		token: z.string().min(1).max(512),
		code: TotpCode,
		label: z.string().trim().min(1).max(60).default("Authenticator app"),
	})
	.strict();
export type TotpEnrolConfirm = z.infer<typeof TotpEnrolConfirm>;

/** Response to a confirmed enrolment: the recovery codes, shown this once. */
export const TotpEnrolDone = z.object({
	recoveryCodes: z.array(z.string()),
});
export type TotpEnrolDone = z.infer<typeof TotpEnrolDone>;

/** `POST /me/second-factor/verify`: an authenticator code or a recovery code. */
export const SecondFactorVerify = z
	.object({ code: z.string().trim().min(1).max(64) })
	.strict();
export type SecondFactorVerify = z.infer<typeof SecondFactorVerify>;
