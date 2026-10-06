import {
	type EgressApplyPolicy,
	GHCR_CACHE_PORT,
	GHCR_UPSTREAM_NAMES,
	HUB_CACHE_PORT,
	HUB_UPSTREAM_NAMES,
	isEgressHostName,
	parseIpv4Cidr,
} from "@portikus/contracts";
import type { EgressEnv } from "./env.js";

/** Ports on the bridge gateway (ADR 0038); fixed with the Incus ACL and Squid config. */
const EGRESS_DNS_PORT = 5300;
const SQUID_HTTP_PORT = 3129;
const SQUID_TLS_PORT = 3130;

const TABLE = "inet portikus_egress";

/**
 * How long an address dnsmasq learned stays in `learned_v4`: the TTL cap
 * dnsmasq gives workspaces, so an address stays only while DNS keeps
 * answering with it (ADR 0038). dnsmasq's add never refreshes a timer, so a
 * busy address drops out on schedule and comes back with the next lookup.
 */
const LEARNED_SECONDS = 300;

/**
 * How long an address stays usable for new connections after the last one
 * made while it was learned. It covers the gap between a learned address
 * timing out and the workspace's next lookup, which its cached answer delays
 * by at most the TTL cap.
 */
const RECENT_SECONDS = LEARNED_SECONDS;

/**
 * Connection-mark bit on a forwarded connection the allow-list accepted, so
 * it outlives its address leaving the sets. The workspace limits table
 * (workspace-limits.nft.j2) uses 0x00100000.
 */
const ACCEPTED_MARK = "0x00200000";

/** Open connections to Squid one workspace may hold, so it cannot exhaust the shared proxy. */
export const SQUID_CONNECTIONS_PER_WORKSPACE = 256;

/**
 * Whether workspace DNS goes through our dnsmasq and web traffic through
 * Squid: always in allow-list mode, and in open mode while any site is
 * blocked (ADR 0043). Open mode with no blocked site is left untouched.
 */
export function usesOurResolver(
	policy: Pick<EgressApplyPolicy, "mode" | "blocked">,
): boolean {
	return policy.mode === "allow-list" || policy.blocked.length > 0;
}

// Belt and braces: the request was already checked, but nothing unchecked
// may reach a file that nft, dnsmasq or Squid parses.
function checkedNames(names: readonly string[]): readonly string[] {
	for (const n of names) {
		if (!isEgressHostName(n))
			throw new Error("refusing to render an invalid host name");
	}
	return names;
}

function checkedRanges(ranges: readonly string[]): readonly string[] {
	for (const r of ranges) {
		if (!parseIpv4Cidr(r)) throw new Error("refusing to render an invalid range");
	}
	return ranges;
}

function checkedPorts(ports: readonly number[]): readonly number[] {
	for (const p of ports) {
		if (!Number.isInteger(p) || p < 1 || p > 65535) {
			throw new Error("refusing to render an invalid port");
		}
	}
	return ports;
}

/** The table's shape; `add` of an existing, identical object is a no-op. */
function declareTable(): string[] {
	return [
		"table inet portikus_egress {",
		// Full fails closed (ADR 0038).
		`\tset learned_v4 {\n\t\ttype ipv4_addr\n\t\tsize 65535\n\t\tflags timeout\n\t\ttimeout ${LEARNED_SECONDS}s\n\t}`,
		`\tset recent_v4 {\n\t\ttype ipv4_addr\n\t\tsize 65535\n\t\tflags dynamic,timeout\n\t\ttimeout ${RECENT_SECONDS}s\n\t}`,
		"\tset ranges_v4 {\n\t\ttype ipv4_addr\n\t\tflags interval\n\t}",
		"\tset ports {\n\t\ttype inet_service\n\t}",
		"\tset squid_conns {\n\t\ttype ipv4_addr\n\t\tsize 65535\n\t\tflags dynamic\n\t}",
		"\tchain prerouting {\n\t\ttype nat hook prerouting priority dstnat - 1\n\t}",
		"\tchain output {\n\t\ttype nat hook output priority dstnat - 1\n\t}",
		"\tchain forward {\n\t\ttype filter hook forward priority filter - 1\n\t}",
		"\tchain input {\n\t\ttype filter hook input priority filter - 1\n\t}",
		"}",
	];
}

function resetTable(flushNames: boolean): string[] {
	return [
		...(flushNames
			? [`flush set ${TABLE} learned_v4`, `flush set ${TABLE} recent_v4`]
			: []),
		`flush set ${TABLE} ranges_v4`,
		`flush set ${TABLE} ports`,
		`flush chain ${TABLE} prerouting`,
		`flush chain ${TABLE} output`,
		`flush chain ${TABLE} forward`,
		`flush chain ${TABLE} input`,
		// The set an older table kept addresses in forever; nothing refers to it once the chains are empty.
		`destroy set ${TABLE} names_v4`,
	];
}

/**
 * Send DNS to our dnsmasq: the workspaces' lookups, and the workspace
 * proxy's own lookups of the names it is asked for, which would otherwise
 * reach Incus's resolver and the internet for any name (ADR 0038). The
 * proxy is matched by its user, which, unlike its cgroup, survives a restart.
 */
function ownResolverRules(env: EgressEnv): string[] {
	const dns = `ip daddr ${env.gateway} meta l4proto { tcp, udp } th dport 53`;
	return [
		`add rule ${TABLE} prerouting iifname "${env.bridge}" ${dns} redirect to :${EGRESS_DNS_PORT}`,
		`add rule ${TABLE} output meta skuid ${env.proxyUid} ${dns} dnat ip to ${env.gateway}:${EGRESS_DNS_PORT}`,
	];
}

/**
 * Cap each workspace's open connections to Squid. A redirected connection
 * reaches input with the proxy's port; conntrack counts the live ones.
 */
function squidCapRule(env: EgressEnv): string {
	return `add rule ${TABLE} input iifname "${env.bridge}" tcp dport { ${SQUID_HTTP_PORT}, ${SQUID_TLS_PORT} } ct state new add @squid_conns { ip saddr ct count over ${SQUID_CONNECTIONS_PER_WORKSPACE} } reject with tcp reset`;
}

function covers(entry: string, host: string): boolean {
	return host === entry || host.endsWith(`.${entry}`);
}

/**
 * Whether the policy's own name matching lets every one of `names` through:
 * each must be listed in allow-list mode, and none blocked in open mode.
 */
export function policyAllowsNames(
	policy: Pick<EgressApplyPolicy, "mode" | "names" | "blocked">,
	names: readonly string[],
): boolean {
	if (policy.mode === "allow-list") {
		return names.every((n) => policy.names.some((entry) => covers(entry, n)));
	}
	return !names.some((n) => policy.blocked.some((entry) => covers(entry, n)));
}

/**
 * The registry caches' gate: a workspace reaches a cache port only when
 * the policy would let it reach the registry itself, so the cache is never a
 * way around the allow-list or a blocked site. It drops every packet, new or
 * established, and nothing in the input chain accepts ahead of it.
 */
function registryGateRules(
	policy: Pick<EgressApplyPolicy, "mode" | "names" | "blocked">,
	env: EgressEnv,
): string[] {
	const rules: string[] = [];
	const input = `add rule ${TABLE} input iifname "${env.bridge}"`;
	if (!policyAllowsNames(policy, HUB_UPSTREAM_NAMES)) {
		rules.push(`${input} tcp dport ${HUB_CACHE_PORT} drop`);
	}
	if (!policyAllowsNames(policy, GHCR_UPSTREAM_NAMES)) {
		rules.push(`${input} tcp dport ${GHCR_CACHE_PORT} drop`);
	}
	return rules;
}

/**
 * While the ghcr.io cache is on the workspace's hosts entry points
 * ghcr.io at the gateway, and its tcp 443 goes to the cache. The gate still
 * decides, because the redirected packet reaches input on the cache port.
 */
function ghcrRedirectRule(env: EgressEnv): string {
	return `add rule ${TABLE} prerouting iifname "${env.bridge}" ip daddr ${env.gateway} tcp dport 443 redirect to :${GHCR_CACHE_PORT}`;
}

/**
 * The `nft -f` script for a policy: one transaction that declares the
 * table, empties it and fills it again. The learned and recent sets keep
 * their addresses unless `flushNames` is set, which the helper does when a
 * name is removed or the mode changes (ADR 0038).
 */
export function renderTable(
	policy: Pick<EgressApplyPolicy, "mode" | "names" | "ranges" | "ports" | "blocked">,
	env: EgressEnv,
	flushNames: boolean,
	ghcrEnabled: boolean,
): string {
	const ranges = checkedRanges(policy.ranges);
	const ports = checkedPorts(policy.ports);
	const lines = [...declareTable(), ...resetTable(flushNames)];
	lines.push(...registryGateRules(policy, env));
	if (ghcrEnabled) lines.push(ghcrRedirectRule(env));
	if (usesOurResolver(policy)) lines.push(...ownResolverRules(env), squidCapRule(env));
	if (policy.mode === "allow-list") {
		const ws = `iifname "${env.bridge}"`;
		if (ranges.length > 0) {
			lines.push(`add element ${TABLE} ranges_v4 { ${ranges.join(", ")} }`);
		}
		lines.push(`add element ${TABLE} ports { ${ports.join(", ")} }`);
		const pre = `add rule ${TABLE} prerouting ${ws}`;
		lines.push(
			`${pre} ip daddr @ranges_v4 return`,
			// A new connection to a learned address keeps it usable a while; only a lookup keeps it learned.
			`${pre} ip daddr @learned_v4 update @recent_v4 { ip daddr }`,
		);
		// A redirect goes to input, not forward, so it must honour the port list itself.
		if (ports.includes(443)) {
			lines.push(
				`${pre} ip daddr @recent_v4 tcp dport 443 redirect to :${SQUID_TLS_PORT}`,
			);
		}
		if (ports.includes(80)) {
			lines.push(
				`${pre} ip daddr @recent_v4 tcp dport 80 redirect to :${SQUID_HTTP_PORT}`,
			);
		}
		const fwd = `add rule ${TABLE} forward ${ws}`;
		lines.push(
			`${fwd} ct mark and ${ACCEPTED_MARK} != 0 accept`,
			`${fwd} meta l4proto { tcp, udp } th dport { 53, 853 } drop`,
			`${fwd} ip daddr @ranges_v4 tcp dport @ports accept`,
			`${fwd} ip daddr @recent_v4 tcp dport @ports ct mark set ct mark or ${ACCEPTED_MARK} accept`,
			`${fwd} drop`,
		);
	} else if (usesOurResolver(policy)) {
		// Open mode with blocked sites: our resolver, and every public web connection through Squid.
		const ws = `iifname "${env.bridge}"`;
		const pre = `add rule ${TABLE} prerouting ${ws}`;
		const publicDst = `ip daddr != { ${checkedRanges(env.deniedRanges).join(", ")} }`;
		lines.push(
			`${pre} ${publicDst} tcp dport 443 redirect to :${SQUID_TLS_PORT}`,
			`${pre} ${publicDst} tcp dport 80 redirect to :${SQUID_HTTP_PORT}`,
			`add rule ${TABLE} forward ${ws} meta l4proto { tcp, udp } th dport { 53, 853 } drop`,
			// QUIC would reach a blocked site's address past Squid; clients fall back to TCP.
			`add rule ${TABLE} forward ${ws} udp dport 443 drop`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** The fallback when the last applied allow-list cannot be loaded at boot: drop all forwarding and both caches. */
export function renderDropAll(env: Pick<EgressEnv, "bridge">): string {
	return `${[
		...declareTable(),
		...resetTable(true),
		`add rule ${TABLE} input iifname "${env.bridge}" tcp dport { ${HUB_CACHE_PORT}, ${GHCR_CACHE_PORT} } drop`,
		`add rule ${TABLE} forward iifname "${env.bridge}" drop`,
	].join("\n")}\n`;
}

/**
 * Our own dnsmasq's configuration (ADR 0038): in allow-list mode listed
 * names go to the upstream and into the names set, and every other name to
 * the worker's counter, which answers NXDOMAIN. In open mode it is the
 * reverse (ADR 0043): every name goes to the upstream except blocked ones.
 * The helper stops the service in open mode with no blocked site.
 */
export function renderDnsmasq(
	policy: Pick<EgressApplyPolicy, "mode" | "names" | "blocked">,
	env: EgressEnv,
): string {
	const open = policy.mode === "open";
	const names = open ? [] : checkedNames(policy.names);
	const blocked = open ? checkedNames(policy.blocked) : [];
	const counter = `127.0.0.1#${env.counterDnsPort}`;
	const lines = [
		`port=${EGRESS_DNS_PORT}`,
		`listen-address=${env.gateway}`,
		"bind-interfaces",
		`no-dhcp-interface=${env.bridge}`,
		"no-resolv",
		"no-hosts",
		"strict-order",
		"stop-dns-rebind",
		// No cache: dnsmasq adds to the set only on an upstream answer, and a timed-out address must come back.
		"cache-size=0",
		`max-ttl=${LEARNED_SECONDS}`,
		"user=nobody",
		"group=nogroup",
		`server=/#/${open ? env.upstream : counter}`,
		`server=/incus/${env.gateway}`,
		"rebind-domain-ok=/incus/",
	];
	for (const n of names) {
		lines.push(
			`server=/${n}/${env.upstream}`,
			`nftset=/${n}/4#inet#portikus_egress#learned_v4`,
		);
	}
	for (const n of blocked) lines.push(`server=/${n}/${counter}`);
	return `${lines.join("\n")}\n`;
}

/** Squid's list: one `.name` per line, matching the name and its subdomains. Empty in open mode. */
export function renderSquidNames(
	policy: Pick<EgressApplyPolicy, "mode" | "names">,
): string {
	if (policy.mode !== "allow-list") return "";
	return checkedNames(policy.names)
		.map((n) => `.${n}\n`)
		.join("");
}

/** Squid's blocked list, in the same form. Empty in allow-list mode, which refuses unlisted names anyway. */
export function renderSquidBlocked(
	policy: Pick<EgressApplyPolicy, "mode" | "blocked">,
): string {
	if (policy.mode !== "open") return "";
	return checkedNames(policy.blocked)
		.map((n) => `.${n}\n`)
		.join("");
}

/**
 * Squid's open-mode switch: a regex list holding "." (matches every name)
 * while open mode has blocked sites, so Squid splices whatever is not
 * blocked. Empty otherwise.
 */
export function renderSquidOpen(
	policy: Pick<EgressApplyPolicy, "mode" | "blocked">,
): string {
	return policy.mode === "open" && policy.blocked.length > 0 ? ".\n" : "";
}
