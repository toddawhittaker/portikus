import { z } from "zod";

/**
 * The workspace egress policy (issue #284; SPEC.md sections 23.1 and 24.9).
 * Allow-list mode decides by host name, never by URL; administrator CIDR
 * ranges are the one address rule. Open mode is the default.
 */

export const EgressMode = z.enum(["open", "allow-list"]);
export type EgressMode = z.infer<typeof EgressMode>;

/** Presets are stored by id and expanded when the policy is applied. */
export const EGRESS_PRESETS = [
	{
		id: "npm",
		label: "npm and Node.js",
		hosts: ["npmjs.org", "yarnpkg.com", "nodejs.org"],
	},
	{ id: "python", label: "Python packages", hosts: ["pypi.org", "pythonhosted.org"] },
	{
		id: "apt",
		label: "Debian and the image's apt repositories",
		hosts: [
			"deb.debian.org",
			"security.debian.org",
			"download.docker.com",
			"deb.nodesource.com",
			"cli.github.com",
		],
	},
	{ id: "docker-hub", label: "Docker Hub", hosts: ["docker.io", "docker.com"] },
	{
		id: "github",
		label: "GitHub",
		hosts: ["github.com", "githubusercontent.com", "ghcr.io"],
	},
	{ id: "gitlab", label: "GitLab", hosts: ["gitlab.com"] },
	{
		id: "claude",
		label: "Claude (Anthropic)",
		hosts: ["anthropic.com", "claude.ai", "claude.com"],
	},
	{ id: "codex", label: "Codex (OpenAI)", hosts: ["openai.com", "chatgpt.com"] },
] as const;

export const EgressPresetId = z.enum([
	"npm",
	"python",
	"apt",
	"docker-hub",
	"github",
	"gitlab",
	"claude",
	"codex",
]);
export type EgressPresetId = z.infer<typeof EgressPresetId>;

/**
 * The IPv4 half of `workspace_egress_denied_ranges` in infra/ansible/site.yml.
 * Those stay denied in both modes; an administrator range may not overlap one.
 */
export const EGRESS_DENIED_RANGES_V4 = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"224.0.0.0/4",
	"240.0.0.0/4",
] as const;

export const EGRESS_LIMITS = {
	hosts: 500,
	blockedSites: 500,
	ranges: 100,
	ports: 20,
	label: 80,
	hostLength: 253,
} as const;

export const EGRESS_DEFAULT_PORTS = [22, 80, 443] as const;

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name entry: letters, digits, hyphens and dots, at least one dot, not an address. */
export function isEgressHostName(value: string): boolean {
	if (value.length === 0 || value.length > EGRESS_LIMITS.hostLength) return false;
	const labels = value.split(".");
	if (labels.length < 2) return false;
	if (!labels.every((l) => LABEL_RE.test(l))) return false;
	// An all-digit last label is an address, not a name.
	return !/^[0-9]+$/.test(labels[labels.length - 1] ?? "");
}

/** Parses a dotted IPv4 address to a 32-bit number, or null. */
export function parseIpv4(value: string): number | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	let out = 0;
	for (const p of parts) {
		if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		out = out * 256 + n;
	}
	return out;
}

/** A parsed range as inclusive first and last addresses. */
export interface Ipv4Range {
	first: number;
	last: number;
}

/** Parses a canonical IPv4 CIDR range (no host bits set), or null. */
export function parseIpv4Cidr(value: string): Ipv4Range | null {
	const m = /^([0-9.]+)\/(0|[1-9][0-9]?)$/.exec(value);
	if (!m) return null;
	const base = parseIpv4(m[1] ?? "");
	const bits = Number(m[2]);
	if (base === null || bits > 32) return null;
	const size = 2 ** (32 - bits);
	if (base % size !== 0) return null;
	return { first: base, last: base + size - 1 };
}

const DENIED = EGRESS_DENIED_RANGES_V4.map((r) => ({
	range: r,
	parsed: parseIpv4Cidr(r) as Ipv4Range,
}));

/** The denied range a range overlaps, or null. */
export function deniedOverlap(range: Ipv4Range): string | null {
	const hit = DENIED.find(
		(d) => range.first <= d.parsed.last && d.parsed.first <= range.last,
	);
	return hit ? hit.range : null;
}

/** Trims and lower-cases what an administrator typed. */
function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export const EgressHost = z
	.string()
	.max(300)
	.transform(normalize)
	.refine(isEgressHostName, {
		message:
			"Enter a host name such as github.com: letters, digits, hyphens and dots, no URL, wildcard or address",
	});

export const EgressRange = z
	.string()
	.max(30)
	.transform((v) => v.trim())
	.superRefine((value, ctx) => {
		const parsed = parseIpv4Cidr(value);
		if (!parsed) {
			ctx.addIssue({
				code: "custom",
				message: "Enter an IPv4 range such as 203.0.113.0/24, with no host bits set",
			});
			return;
		}
		const denied = deniedOverlap(parsed);
		if (denied) {
			ctx.addIssue({
				code: "custom",
				message: `The range overlaps the private range ${denied}, which stays denied`,
			});
		}
	});

export const EgressLabel = z.string().trim().max(EGRESS_LIMITS.label);

export const EgressEntryKind = z.enum(["host", "range"]);
export type EgressEntryKind = z.infer<typeof EgressEntryKind>;

export const EgressEntry = z
	.object({
		id: z.string().uuid(),
		kind: EgressEntryKind,
		value: z.string(),
		label: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.strict();
export type EgressEntry = z.infer<typeof EgressEntry>;

export const EgressPorts = z
	.array(z.number().int().min(1).max(65535))
	.min(1)
	.max(EGRESS_LIMITS.ports)
	.refine((ports) => new Set(ports).size === ports.length, {
		message: "Each port may appear once",
	});

/** Every write carries the version it was based on; a stale one gets 409. */
const Version = z.number().int().nonnegative();

export const EgressModeRequest = z
	.object({ version: Version, mode: EgressMode })
	.strict();
export type EgressModeRequest = z.infer<typeof EgressModeRequest>;

export const EgressPresetsRequest = z
	.object({
		version: Version,
		presets: z.array(EgressPresetId).refine((p) => new Set(p).size === p.length, {
			message: "Each preset may appear once",
		}),
	})
	.strict();
export type EgressPresetsRequest = z.infer<typeof EgressPresetsRequest>;

export const EgressPortsRequest = z
	.object({ version: Version, ports: EgressPorts })
	.strict();
export type EgressPortsRequest = z.infer<typeof EgressPortsRequest>;

export const EgressEntryRequest = z.discriminatedUnion("kind", [
	z
		.object({
			version: Version,
			kind: z.literal("host"),
			value: EgressHost,
			label: EgressLabel,
		})
		.strict(),
	z
		.object({
			version: Version,
			kind: z.literal("range"),
			value: EgressRange,
			label: EgressLabel,
		})
		.strict(),
]);
export type EgressEntryRequest = z.input<typeof EgressEntryRequest>;

/** A blocked site: a host name that covers its subdomains, used in open mode only. */
export const EgressBlockedSite = z
	.object({
		id: z.string().uuid(),
		value: z.string(),
		label: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.strict();
export type EgressBlockedSite = z.infer<typeof EgressBlockedSite>;

export const EgressBlockedSiteRequest = z
	.object({ version: Version, value: EgressHost, label: EgressLabel })
	.strict();
export type EgressBlockedSiteRequest = z.input<typeof EgressBlockedSiteRequest>;

/**
 * The public DNS-over-HTTPS services seeded into the blocked sites once, so a
 * tool cannot look a blocked name up past our resolver. Removable.
 */
export const EGRESS_DEFAULT_BLOCKED_SITES = [
	"cloudflare-dns.com",
	"dns.adguard-dns.com",
	"dns.google",
	"dns.nextdns.io",
	"dns.quad9.net",
	"doh.cleanbrowsing.org",
	"doh.opendns.com",
	"one.one.one.one",
] as const;

/** The version of a DELETE rides in the query string: `?version=N`. */
export const EgressDeleteQuery = z.object({
	version: z.coerce.number().int().nonnegative(),
});

/** The policy as `explainHost` and the apply loop read it. */
export interface EgressPolicy {
	mode: EgressMode;
	presets: readonly EgressPresetId[];
	ports: readonly number[];
	entries: readonly { kind: EgressEntryKind; value: string; label: string }[];
	/** Refused in open mode only; allow-list mode already refuses what it does not list. */
	blockedSites: readonly { value: string; label: string }[];
}

/** Why a host would, or would not, be allowed. It does no live lookup. */
export const EgressExplanation = z.discriminatedUnion("reason", [
	z.object({ allowed: z.literal(true), reason: z.literal("open") }),
	z.object({
		allowed: z.literal(true),
		reason: z.literal("preset"),
		preset: EgressPresetId,
		presetLabel: z.string(),
		entry: z.string(),
	}),
	z.object({
		allowed: z.literal(true),
		reason: z.literal("entry"),
		entry: z.string(),
		label: z.string(),
	}),
	z.object({
		allowed: z.literal(true),
		reason: z.literal("range"),
		range: z.string(),
		label: z.string(),
	}),
	/** An address in a private range, denied in both modes. */
	z.object({
		allowed: z.literal(false),
		reason: z.literal("denied"),
		range: z.string(),
	}),
	/** An address only a range, or a lookup of a listed name, can allow. */
	z.object({ allowed: z.literal(false), reason: z.literal("address") }),
	z.object({ allowed: z.literal(false), reason: z.literal("not-listed") }),
	/** Open mode, and a blocked site covers the name. */
	z.object({
		allowed: z.literal(false),
		reason: z.literal("blocked"),
		entry: z.string(),
		label: z.string(),
	}),
	z.object({ allowed: z.literal(false), reason: z.literal("invalid") }),
]);
export type EgressExplanation = z.infer<typeof EgressExplanation>;

function covers(entry: string, host: string): boolean {
	return host === entry || host.endsWith(`.${entry}`);
}

/**
 * Whether the policy lets a workspace reach `input`, and why. Shared by the
 * admin route, the Network tab and the enforcement renderers' tests, so the
 * explanation and the enforcement cannot disagree.
 */
export function explainHost(policy: EgressPolicy, input: string): EgressExplanation {
	const value = normalize(input);
	const address = parseIpv4(value);
	if (address !== null) {
		const denied = deniedOverlap({ first: address, last: address });
		if (denied) return { allowed: false, reason: "denied", range: denied };
		if (policy.mode === "open") return { allowed: true, reason: "open" };
		for (const e of policy.entries) {
			if (e.kind !== "range") continue;
			const r = parseIpv4Cidr(e.value);
			if (r && r.first <= address && address <= r.last) {
				return { allowed: true, reason: "range", range: e.value, label: e.label };
			}
		}
		return { allowed: false, reason: "address" };
	}
	if (!isEgressHostName(value)) return { allowed: false, reason: "invalid" };
	if (policy.mode === "open") {
		const block = policy.blockedSites.find((b) => covers(b.value, value));
		if (block) {
			return {
				allowed: false,
				reason: "blocked",
				entry: block.value,
				label: block.label,
			};
		}
		return { allowed: true, reason: "open" };
	}
	for (const preset of EGRESS_PRESETS) {
		if (!policy.presets.includes(preset.id)) continue;
		const hit = preset.hosts.find((h) => covers(h, value));
		if (hit) {
			return {
				allowed: true,
				reason: "preset",
				preset: preset.id,
				presetLabel: preset.label,
				entry: hit,
			};
		}
	}
	for (const e of policy.entries) {
		if (e.kind === "host" && covers(e.value, value)) {
			return { allowed: true, reason: "entry", entry: e.value, label: e.label };
		}
	}
	return { allowed: false, reason: "not-listed" };
}

/**
 * The policy with its presets expanded, as the apply loop sends it to the
 * controller's `PUT /egress-policy` (without the version).
 */
export function expandEgressPolicy(policy: EgressPolicy): {
	mode: EgressMode;
	names: string[];
	ranges: string[];
	ports: number[];
	blocked: string[];
} {
	const names = new Set<string>();
	for (const preset of EGRESS_PRESETS) {
		if (policy.presets.includes(preset.id)) for (const h of preset.hosts) names.add(h);
	}
	const ranges: string[] = [];
	for (const e of policy.entries) {
		if (e.kind === "host") names.add(e.value);
		else ranges.push(e.value);
	}
	return {
		mode: policy.mode,
		names: [...names].sort(),
		ranges: ranges.sort(),
		ports: [...policy.ports].sort((a, b) => a - b),
		// Only open mode uses them, so allow-list mode sends none.
		blocked:
			policy.mode === "open" ? policy.blockedSites.map((b) => b.value).sort() : [],
	};
}

/** `GET /admin/egress`, also the answer to every write. */
export const AdminEgressView = z
	.object({
		version: z.number().int(),
		mode: EgressMode,
		presets: z.array(EgressPresetId),
		ports: z.array(z.number().int()),
		entries: z.array(EgressEntry),
		blockedSites: z.array(EgressBlockedSite),
		presetCatalog: z.array(
			z.object({ id: EgressPresetId, label: z.string(), hosts: z.array(z.string()) }),
		),
		apply: z.object({
			appliedVersion: z.number().int().nullable(),
			appliedAt: z.string().nullable(),
			error: z.string().nullable(),
		}),
		/** Site-wide top 20 refused names over the last 7 days; never per workspace. */
		blocked: z.array(z.object({ name: z.string(), count: z.number().int() })),
	})
	.strict();
export type AdminEgressView = z.infer<typeof AdminEgressView>;

const PRESET_HOST_COUNT = EGRESS_PRESETS.reduce((n, p) => n + p.hosts.length, 0);

/**
 * The expanded policy the worker sends to the controller's
 * `PUT /egress-policy`, and the controller hands to the root helper. The
 * helper checks it again with this same schema before any value reaches a
 * file or the firewall, so a name here can never carry a newline, space,
 * slash or `#` into dnsmasq, nft or Squid.
 */
export const EgressApplyPolicy = z
	.object({
		version: z.number().int().nonnegative().max(2_147_483_647),
		mode: EgressMode,
		names: z
			.array(z.string().refine(isEgressHostName))
			.max(EGRESS_LIMITS.hosts + PRESET_HOST_COUNT)
			.refine((n) => new Set(n).size === n.length),
		ranges: z
			.array(
				z.string().refine((r) => {
					const parsed = parseIpv4Cidr(r);
					return parsed !== null && deniedOverlap(parsed) === null;
				}),
			)
			.max(EGRESS_LIMITS.ranges)
			.refine((r) => new Set(r).size === r.length),
		ports: EgressPorts,
		/**
		 * Refused names in open mode; must be empty in allow-list mode. Absent
		 * from an applied.json written before blocked sites existed.
		 */
		blocked: z
			.array(z.string().refine(isEgressHostName))
			.max(EGRESS_LIMITS.blockedSites)
			.refine((n) => new Set(n).size === n.length)
			.default([]),
	})
	.strict()
	.refine((p) => p.mode === "open" || p.blocked.length === 0, {
		message: "Blocked sites apply only in open mode",
		path: ["blocked"],
	});
export type EgressApplyPolicy = z.infer<typeof EgressApplyPolicy>;

/** `GET /egress-policy` on the controller, and the answer to a successful PUT. */
export const EgressApplyStatus = z
	.object({
		appliedVersion: z.number().int().nullable(),
		appliedAt: z.string().nullable(),
		error: z.string().nullable(),
	})
	.strict();
export type EgressApplyStatus = z.infer<typeof EgressApplyStatus>;
