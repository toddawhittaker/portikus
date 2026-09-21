import { z } from "zod";

/**
 * How a preview is shown to the student: inside the Portikus page, or as a
 * top-level browser tab (BROWSER-HANDLING.md §9.1).
 */
export const PreviewPresentation = z.enum(["embedded", "top-level"]);
export type PreviewPresentation = z.infer<typeof PreviewPresentation>;

/**
 * Request body for `POST /workspaces/{id}/preview-grants`
 * (BROWSER-HANDLING.md §9.1). The port range allowed by policy is narrower
 * than this; the route checks it against the configured range.
 */
export const PreviewGrantRequest = z.object({
	port: z.number().int().min(1).max(65535),
	presentation: PreviewPresentation,
});
export type PreviewGrantRequest = z.infer<typeof PreviewGrantRequest>;

/**
 * Response body for `POST /workspaces/{id}/preview-grants`
 * (BROWSER-HANDLING.md §9.1).
 */
export const PreviewGrantResponse = z.object({
	previewOrigin: z.string().url(),
	bootstrapUrl: z.string().url(),
	expiresAt: z.string().datetime(),
});
export type PreviewGrantResponse = z.infer<typeof PreviewGrantResponse>;

/**
 * Response body for `GET /workspaces/{id}/preview/embeddable`
 * (BROWSER-HANDLING.md §12). The control plane asks the student's
 * application once whether it allows being framed, because a parent page
 * cannot see that answer for itself: the browser fires the frame's load
 * event even for a navigation it refused.
 */
export const PreviewEmbeddableResponse = z.object({
	embeddable: z.boolean(),
	reason: z.enum(["x-frame-options", "frame-ancestors", "unreachable"]).optional(),
});
export type PreviewEmbeddableResponse = z.infer<typeof PreviewEmbeddableResponse>;

/** Longest a single DNS label may be. */
const MAX_LABEL_LENGTH = 63;

/** Longest a full DNS name may be. */
const MAX_HOST_LENGTH = 253;

/** A workspace label as it may appear in a preview host. */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A port with no sign, no leading zero, and no alternate numeric form. */
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;

/**
 * Build the preview host for a workspace and port
 * (BROWSER-HANDLING.md §8): `<label>-<port>.<suffix>`.
 */
export function previewHost(label: string, port: number, suffix: string): string {
	return `${label}-${port}.${suffix}`;
}

/**
 * Parse a preview host back into its workspace label and port, or return
 * null (BROWSER-HANDLING.md §8).
 *
 * Deliberately strict: it accepts only lowercase ASCII, one label in front
 * of the suffix, and a plain decimal port. It rejects the application host,
 * extra labels, Unicode, signs, leading zeros, and overflow. A valid host is
 * a routing name only and never evidence that the requester may reach the
 * workspace.
 *
 * The caller must strip any `:port` from an HTTP `Host` header first; a host
 * containing a colon is rejected.
 */
export function parsePreviewHost(
	host: string,
	suffix: string,
): { label: string; port: number } | null {
	if (typeof host !== "string" || typeof suffix !== "string") return null;
	if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;
	if (suffix.length === 0) return null;

	// Host names are case-insensitive, but nothing else is normalized: a
	// trailing dot, a port, or a userinfo part means the caller gave us
	// something we were not meant to route.
	const normalized = host.toLowerCase();
	const normalizedSuffix = suffix.toLowerCase();

	const tail = `.${normalizedSuffix}`;
	if (!normalized.endsWith(tail)) return null;

	const first = normalized.slice(0, normalized.length - tail.length);
	if (first.length === 0 || first.length > MAX_LABEL_LENGTH) return null;
	// One label only: a dot here would mean an extra level under the suffix.
	if (first.includes(".")) return null;

	const hyphen = first.lastIndexOf("-");
	if (hyphen <= 0 || hyphen === first.length - 1) return null;

	const label = first.slice(0, hyphen);
	const portText = first.slice(hyphen + 1);

	if (!LABEL_PATTERN.test(label)) return null;
	if (!PORT_PATTERN.test(portText)) return null;

	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

	return { label, port };
}
