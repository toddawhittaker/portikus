import type { ApiConfig } from "@portikus/config";

/**
 * Whether a port may ever be previewed (BROWSER-HANDLING.md §8, §23). The
 * configured range and deny list are the whole policy; a listening service on
 * a denied port is still refused.
 */
export function portAllowed(config: ApiConfig, port: number): boolean {
	if (!Number.isInteger(port)) return false;
	if (port < config.PREVIEW_PORT_MIN || port > config.PREVIEW_PORT_MAX) return false;
	return !config.previewDeniedPorts.includes(port);
}

/** The public port a preview URL carries; 443 is left off the host. */
export function previewPublicPort(config: ApiConfig): number | null {
	let port: string;
	try {
		port = new URL(config.PUBLIC_URL).port;
	} catch {
		return null;
	}
	if (port === "") return null;
	const parsed = Number(port);
	return Number.isInteger(parsed) && parsed !== 443 ? parsed : null;
}

/** The origin of a preview host, with the public port when it is not 443. */
export function previewOriginFor(config: ApiConfig, host: string): string {
	const port = previewPublicPort(config);
	return `https://${host}${port === null ? "" : `:${port}`}`;
}

/**
 * The host a request is for, from Caddy's X-Forwarded-Host or the Host
 * header, with any `:port` removed. Returns null when there is none, or when
 * the value is not a plain host name.
 */
export function requestHost(headers: Record<string, unknown>): string | null {
	const raw = headers["x-forwarded-host"] ?? headers.host;
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string" || value === "") return null;
	// An IPv6 literal is never a preview host, and neither is a userinfo part.
	if (value.includes("[") || value.includes("@")) return null;
	const colon = value.indexOf(":");
	const host = colon === -1 ? value : value.slice(0, colon);
	return host === "" ? null : host.toLowerCase();
}
