/** The `Set-Cookie` attributes of the preview session cookie. */
export type PreviewCookieOptions = {
	httpOnly: true;
	secure: boolean;
	sameSite: "strict" | "none";
	partitioned?: true;
	path: "/";
};

/**
 * The attributes of the preview session cookie (BROWSER-HANDLING.md §7.2).
 *
 * A browser sends a `SameSite=Strict` cookie inside a frame only when the
 * frame and the top-level page are the same site. When the preview suffix is
 * a different site from the app host, an embedded preview's bootstrap
 * arrives with `Sec-Fetch-Site: cross-site`, and its cookie is set
 * `SameSite=None; Secure; Partitioned` so that it is sent only inside the
 * Portikus top-level site that framed it. The request's own header decides,
 * not a public-suffix list. Everything else, including a missing header and
 * every tab, keeps `SameSite=Strict`. Clearing the cookie passes the same
 * request headers, so the expiry carries the attributes the cookie was set with.
 */
export function previewCookieOptions(
	headers: Record<string, unknown>,
	embedded: boolean,
	secure: boolean,
): PreviewCookieOptions {
	if (embedded && headers["sec-fetch-site"] === "cross-site") {
		return {
			httpOnly: true,
			secure: true,
			sameSite: "none",
			partitioned: true,
			path: "/",
		};
	}
	return { httpOnly: true, secure, sameSite: "strict", path: "/" };
}
