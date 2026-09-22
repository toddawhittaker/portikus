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
 * Whether a dotted-quad address is loopback, unspecified, private, or
 * link-local. The WHATWG URL parser has already normalised short forms such
 * as `127.1` to four octets by the time this sees them.
 */
function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
	if (octets.some((octet) => octet < 0 || octet > 255)) return false;
	const [a, b] = octets as [number, number, number, number];
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 0) return true; // 0.0.0.0/8, the unspecified address
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	// 100.64.0.0/10, the range carriers and some cloud networks use between
	// their own machines. It is not reachable from the public internet.
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
	return false;
}

/**
 * An IPv6 address as eight 16-bit groups, or null if it is not one. Accepts
 * the `::` shorthand and a trailing dotted-quad, which is how IPv4-mapped
 * addresses are sometimes written.
 */
function parseIpv6(host: string): number[] | null {
	let text = host;
	const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
	if (dotted?.[1]) {
		const octets = dotted[1].split(".").map(Number);
		if (octets.some((octet) => octet > 255)) return null;
		const [a, b, c, d] = octets as [number, number, number, number];
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const toGroups = (part: string): number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
			groups.push(Number.parseInt(piece, 16));
		}
		return groups;
	};
	const head = toGroups(halves[0] ?? "");
	const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const gap = 8 - head.length - tail.length;
	if (gap < 1) return null;
	return [...head, ...Array<number>(gap).fill(0), ...tail];
}

/** Whether an IPv6 address means this machine or a private network. */
function isPrivateIpv6(host: string): boolean {
	const groups = parseIpv6(host);
	if (groups === null) return false;
	const [first] = groups as [number, ...number[]];
	const isZero = groups.slice(0, 5).every((group) => group === 0);
	// ::1 loopback and :: unspecified.
	if (isZero && groups[5] === 0 && groups[6] === 0 && (groups[7] ?? 0) <= 1)
		return true;
	// ::ffff:a.b.c.d, the IPv4-mapped form: judge it as the IPv4 address.
	if (isZero && groups[5] === 0xffff) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		const quad = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
		return isPrivateIpv4(quad);
	}
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	return false;
}

/**
 * Whether a hostname means this machine or a private network, and so must
 * never be opened as an external link (SPEC.md §24.2, §24.7). Checked by
 * range rather than by a list of literals, because `127.0.0.2` and `127.1`
 * reach the same loopback interface that `127.0.0.1` does. A single trailing
 * dot is the absolute DNS form of the same name.
 */
export function isLocalOrPrivateHost(host: string): boolean {
	const name = host.endsWith(".") ? host.slice(0, -1) : host;
	if (name === "localhost" || name.endsWith(".localhost")) return true;
	if (name.startsWith("[") && name.endsWith("]")) {
		return isPrivateIpv6(name.slice(1, -1));
	}
	if (isPrivateIpv4(name)) return true;
	// A bare IPv6 address, in case the parser ever hands one over unbracketed.
	return name.includes(":") && isPrivateIpv6(name);
}

/**
 * Accept only http(s), then split loopback and private hosts from everything
 * else (BROWSER-HANDLING.md §18). Preview versus login is not decided here.
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

	if (isLocalOrPrivateHost(url.hostname.toLowerCase())) {
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
