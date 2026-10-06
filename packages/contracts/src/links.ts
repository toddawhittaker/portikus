import { z } from "zod";

/**
 * Linking a course account to an SSO account (ADR 0026). An SSO account signs in through the institution's OpenID Connect
 * provider; a course account was created by an LTI launch.
 */

/** One course sign-in linked to the caller's SSO account. */
export const AccountLink = z.object({
	courseUserId: z.string().uuid(),
	/** The LTI registration's name. */
	platformName: z.string(),
	displayName: z.string(),
	linkedAt: z.string().datetime(),
});
export type AccountLink = z.infer<typeof AccountLink>;

/** `GET /me/links`. */
export const MyLinks = z.object({
	source: z.enum(["sso", "course"]),
	/** Session creation plus 15 minutes, for a course session only. */
	linkUntil: z.string().datetime().nullable(),
	links: z.array(AccountLink),
	/**
	 * Set only when this session came from a launch of a linked course
	 * identity: that identity, which this session may unlink.
	 */
	launch: z
		.object({ courseUserId: z.string().uuid(), platformName: z.string() })
		.nullable(),
});
export type MyLinks = z.infer<typeof MyLinks>;

/** `POST /me/links/start`: where the browser goes to sign in with SSO. */
export const StartLinkResponse = z.object({ redirectUrl: z.string().url() });
export type StartLinkResponse = z.infer<typeof StartLinkResponse>;

/**
 * `POST /me/links/:courseUserId/unlink`. `signedOut` is true when a launch
 * session unlinked its own course identity: that session has ended, and the
 * user opens Portikus again from the course.
 */
export const UnlinkResponse = z.object({ signedOut: z.boolean() });
export type UnlinkResponse = z.infer<typeof UnlinkResponse>;

/** `GET /me/links/pending`: the two accounts the confirmation page names. */
export const PendingLink = z.object({
	course: z.object({ displayName: z.string(), platformName: z.string() }),
	sso: z.object({
		displayName: z.string(),
		signInName: z.string().nullable(),
		email: z.string().nullable(),
	}),
	/**
	 * What a Dex local-password account must do before it can be linked
	 * (SPEC.md section 24.13): type a code, or set up two-step sign-in
	 * first. Null when no code is needed.
	 */
	secondFactor: z.enum(["verify", "enrol"]).nullable(),
});
export type PendingLink = z.infer<typeof PendingLink>;

/** `POST /me/links/confirm`: the SSO account's code, when it needs one. */
export const LinkConfirm = z
	.object({ code: z.string().trim().min(1).max(64).optional() })
	.strict();
export type LinkConfirm = z.infer<typeof LinkConfirm>;

/** The `?error=` codes the link-mode callback sends to `/link`. */
export const LinkError = z.enum([
	"no_account",
	"not_authorized",
	"session_changed",
	"expired",
	"already_linked",
	"failed",
]);
export type LinkError = z.infer<typeof LinkError>;
