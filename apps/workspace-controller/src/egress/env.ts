import { deniedOverlap, parseIpv4, parseIpv4Cidr } from "@portikus/contracts";

/** The helper's configuration, from the Ansible-written /etc/portikus/egress.env. */
export interface EgressEnv {
	/** The workspace bridge, such as portikus-ws. */
	bridge: string;
	/** The bridge gateway, where our dnsmasq and the workspace Squid listen. */
	gateway: string;
	/** The workspace bridge's subnet, whose connections the helper forgets when blocks change. */
	subnet: string;
	/** Where dnsmasq sends a listed name; 127.0.0.53 is systemd-resolved. */
	upstream: string;
	/** The blocked-name counter's DNS port on 127.0.0.1. */
	counterDnsPort: number;
	/** The private ranges that stay denied; a policy range may not overlap one. */
	deniedRanges: string[];
	/** The workspace proxy's user id, whose own DNS lookups go to our dnsmasq. */
	proxyUid: number;
}

const KEYS = [
	"EGRESS_BRIDGE",
	"EGRESS_GATEWAY",
	"EGRESS_SUBNET",
	"EGRESS_UPSTREAM",
	"EGRESS_COUNTER_DNS_PORT",
	"EGRESS_DENIED_RANGES",
	"EGRESS_PROXY_UID",
] as const;

// Linux interface names are at most 15 bytes.
export const BRIDGE_RE = /^[a-z0-9][a-z0-9-]{0,14}$/;

/**
 * Parse `KEY=value` lines, refusing anything unexpected: an unknown or
 * repeated key, a missing key, or a value outside its pattern. Every value
 * ends up in nft or dnsmasq text, so each is checked here, not trusted.
 */
export function parseEgressEnv(text: string): EgressEnv {
	const values = new Map<string, string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) throw new Error("egress.env has a line that is not KEY=value");
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (!(KEYS as readonly string[]).includes(key)) {
			throw new Error("egress.env has an unknown key");
		}
		if (values.has(key)) throw new Error(`egress.env repeats ${key}`);
		values.set(key, value);
	}
	const get = (key: (typeof KEYS)[number]): string => {
		const v = values.get(key);
		if (v === undefined) throw new Error(`egress.env is missing ${key}`);
		return v;
	};

	const bridge = get("EGRESS_BRIDGE");
	if (!BRIDGE_RE.test(bridge)) throw new Error("egress.env EGRESS_BRIDGE is not valid");
	const gateway = get("EGRESS_GATEWAY");
	if (parseIpv4(gateway) === null) {
		throw new Error("egress.env EGRESS_GATEWAY is not an IPv4 address");
	}
	const subnet = get("EGRESS_SUBNET");
	if (parseIpv4Cidr(subnet) === null) {
		throw new Error("egress.env EGRESS_SUBNET is not a range");
	}
	const upstream = get("EGRESS_UPSTREAM");
	if (parseIpv4(upstream) === null) {
		throw new Error("egress.env EGRESS_UPSTREAM is not an IPv4 address");
	}
	const portText = get("EGRESS_COUNTER_DNS_PORT");
	const counterDnsPort = Number(portText);
	if (!/^[1-9][0-9]{0,4}$/.test(portText) || counterDnsPort > 65535) {
		throw new Error("egress.env EGRESS_COUNTER_DNS_PORT is not a port");
	}
	const deniedRanges = get("EGRESS_DENIED_RANGES").split(",");
	for (const r of deniedRanges) {
		if (parseIpv4Cidr(r) === null) {
			throw new Error(
				"egress.env EGRESS_DENIED_RANGES holds a value that is not a range",
			);
		}
	}
	const uidText = get("EGRESS_PROXY_UID");
	// Never root: the rule it feeds would catch the host's own lookups.
	if (!/^[1-9][0-9]{0,9}$/.test(uidText) || Number(uidText) > 4294967294) {
		throw new Error("egress.env EGRESS_PROXY_UID is not a user id");
	}
	const proxyUid = Number(uidText);
	return { bridge, gateway, subnet, upstream, counterDnsPort, deniedRanges, proxyUid };
}

/** Whether a policy range overlaps a built-in or configured denied range. */
export function overlapsDenied(env: EgressEnv, range: string): boolean {
	const r = parseIpv4Cidr(range);
	if (!r || deniedOverlap(r)) return true;
	return env.deniedRanges.some((d) => {
		const p = parseIpv4Cidr(d);
		return p !== null && r.first <= p.last && p.first <= r.last;
	});
}
