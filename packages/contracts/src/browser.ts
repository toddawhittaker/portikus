import { z } from "zod";

/**
 * Longest URL the broker will read (BROWSER-HANDLING.md §18, §25.2).
 * Checked on the raw string, before parsing.
 */
export const MAX_BROKER_URL_LENGTH = 4096;

/** Returned by `redactUrl` when the input is not a parseable URL. */
export const REDACTED_URL = "[redacted-url]";

/**
 * What the `portikus-open` shim sends over the workspace unix socket
 * (BROWSER-HANDLING.md §18). The URL is still complete here; redaction
 * happens at the log boundary.
 */
export const BrokerOpenRequest = z
	.object({
		requestId: z.string().uuid(),
		url: z.string().min(1).max(MAX_BROKER_URL_LENGTH),
		executable: z.string().min(1).optional(),
		pid: z.number().int().nonnegative().optional(),
		cwd: z.string().min(1).optional(),
	})
	.strict();
export type BrokerOpenRequest = z.infer<typeof BrokerOpenRequest>;

/** One-line reply on that same socket. */
export const BrokerOpenReply = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true) }).strict(),
	z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);
export type BrokerOpenReply = z.infer<typeof BrokerOpenReply>;

/**
 * How the agent classified an accepted open, after looking at the process
 * (BROWSER-HANDLING.md §19). The URL text alone never decides preview
 * versus login.
 */
export const BrokerClass = z.enum(["external", "loopback-preview", "loopback-login"]);
export type BrokerClass = z.infer<typeof BrokerClass>;

/**
 * Frame on the events socket (BROWSER-HANDLING.md §18). Named `brokerClass`
 * so the wire key is not the reserved word `class`.
 */
export const BrowserOpenRequest = z
	.object({
		type: z.literal("browser.open.request"),
		requestId: z.string().uuid(),
		workspaceId: z.string().uuid(),
		terminalId: z.string().uuid().optional(),
		url: z.string().min(1).max(MAX_BROKER_URL_LENGTH),
		brokerClass: BrokerClass,
		source: z
			.object({
				executable: z.string().min(1).optional(),
				pid: z.number().int().nonnegative().optional(),
				cwd: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
		requestedAt: z.string().datetime(),
	})
	.strict();
export type BrowserOpenRequest = z.infer<typeof BrowserOpenRequest>;

function hasControlCharacter(raw: string): boolean {
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export type ClassifiedBrokerUrl =
	| {
			outcome: "reject";
			reason: "too-long" | "control-character" | "malformed" | "scheme" | "userinfo";
	  }
	| { outcome: "loopback"; port?: number }
	| { outcome: "external"; origin: string };

function loopbackPort(url: URL): number | undefined {
	if (url.port === "") return undefined;
	return Number(url.port);
}

/**
 * Accept only http(s), then split loopback from everything else
 * (BROWSER-HANDLING.md §18). Loopback is `127.0.0.1`, `localhost`, or
 * `::1`. Preview versus login is not decided here.
 */
export function classifyBrokerUrl(raw: string): ClassifiedBrokerUrl {
	if (raw.length > MAX_BROKER_URL_LENGTH)
		return { outcome: "reject", reason: "too-long" };
	if (hasControlCharacter(raw)) {
		return { outcome: "reject", reason: "control-character" };
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { outcome: "reject", reason: "malformed" };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { outcome: "reject", reason: "scheme" };
	}
	if (url.username !== "" || url.password !== "") {
		return { outcome: "reject", reason: "userinfo" };
	}

	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
		const port = loopbackPort(url);
		return port === undefined ? { outcome: "loopback" } : { outcome: "loopback", port };
	}

	return { outcome: "external", origin: url.origin };
}

/**
 * Scheme, host, and port only (BROWSER-HANDLING.md §21.3). Anything that
 * does not parse becomes `REDACTED_URL`, with none of the input copied out.
 */
export function redactUrl(raw: string): string {
	if (raw.length > MAX_BROKER_URL_LENGTH || hasControlCharacter(raw))
		return REDACTED_URL;
	try {
		const url = new URL(raw);
		if (url.origin === "null") return REDACTED_URL;
		return url.origin;
	} catch {
		return REDACTED_URL;
	}
}
