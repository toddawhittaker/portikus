import {
	type EgressApplyPolicy,
	isEgressHostName,
	parseIpv4Cidr,
} from "@portikus/contracts";
import type { EgressEnv } from "./env.js";

/** Ports on the bridge gateway (ADR 0038); fixed with the Incus ACL and Squid config. */
export const EGRESS_DNS_PORT = 5300;
export const SQUID_HTTP_PORT = 3129;
export const SQUID_TLS_PORT = 3130;

const TABLE = "inet portikus_egress";

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
		// No timeout: dnsmasq's plain add never refreshes one (ADR 0038). Full fails closed.
		"\tset names_v4 {\n\t\ttype ipv4_addr\n\t\tsize 65535\n\t}",
		"\tset ranges_v4 {\n\t\ttype ipv4_addr\n\t\tflags interval\n\t}",
		"\tset ports {\n\t\ttype inet_service\n\t}",
		"\tchain prerouting {\n\t\ttype nat hook prerouting priority dstnat - 1\n\t}",
		"\tchain output {\n\t\ttype nat hook output priority dstnat - 1\n\t}",
		"\tchain forward {\n\t\ttype filter hook forward priority filter - 1\n\t}",
		"}",
	];
}

function resetTable(flushNames: boolean): string[] {
	return [
		...(flushNames ? [`flush set ${TABLE} names_v4`] : []),
		`flush set ${TABLE} ranges_v4`,
		`flush set ${TABLE} ports`,
		`flush chain ${TABLE} prerouting`,
		`flush chain ${TABLE} output`,
		`flush chain ${TABLE} forward`,
	];
}

/** Whether our dnsmasq resolves for workspaces and the workspace proxy in a mode. */
function usesOwnResolver(mode: EgressApplyPolicy["mode"]): boolean {
	return mode === "allow-list";
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
 * The `nft -f` script for a policy: one transaction that declares the
 * table, empties it and fills it again. The names set keeps the addresses
 * dnsmasq learned unless `flushNames` is set, which the helper does when a
 * name is removed or the mode changes (ADR 0038).
 */
export function renderTable(
	policy: Pick<EgressApplyPolicy, "mode" | "ranges" | "ports">,
	env: EgressEnv,
	flushNames: boolean,
): string {
	const ranges = checkedRanges(policy.ranges);
	const ports = checkedPorts(policy.ports);
	const lines = [...declareTable(), ...resetTable(flushNames)];
	if (usesOwnResolver(policy.mode)) lines.push(...ownResolverRules(env));
	if (policy.mode === "allow-list") {
		const ws = `iifname "${env.bridge}"`;
		if (ranges.length > 0) {
			lines.push(`add element ${TABLE} ranges_v4 { ${ranges.join(", ")} }`);
		}
		lines.push(`add element ${TABLE} ports { ${ports.join(", ")} }`);
		const pre = `add rule ${TABLE} prerouting ${ws}`;
		lines.push(`${pre} ip daddr @ranges_v4 return`);
		// A redirect goes to input, not forward, so it must honour the port list itself.
		if (ports.includes(443)) {
			lines.push(
				`${pre} ip daddr @names_v4 tcp dport 443 redirect to :${SQUID_TLS_PORT}`,
			);
		}
		if (ports.includes(80)) {
			lines.push(
				`${pre} ip daddr @names_v4 tcp dport 80 redirect to :${SQUID_HTTP_PORT}`,
			);
		}
		const fwd = `add rule ${TABLE} forward ${ws}`;
		lines.push(
			`${fwd} meta l4proto { tcp, udp } th dport { 53, 853 } drop`,
			`${fwd} ip daddr @ranges_v4 tcp dport @ports accept`,
			`${fwd} ip daddr @names_v4 tcp dport @ports accept`,
			`${fwd} drop`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** The fallback when the last applied allow-list cannot be loaded at boot: drop all forwarding. */
export function renderDropAll(env: Pick<EgressEnv, "bridge">): string {
	return `${[
		...declareTable(),
		...resetTable(true),
		`add rule ${TABLE} forward iifname "${env.bridge}" drop`,
	].join("\n")}\n`;
}

/**
 * Our own dnsmasq's configuration (ADR 0038): listed names go to the
 * upstream and into the names set; every other name goes to the worker's
 * counter, which answers NXDOMAIN. Open mode renders no names; the helper
 * stops the service then.
 */
export function renderDnsmasq(
	policy: Pick<EgressApplyPolicy, "mode" | "names">,
	env: EgressEnv,
): string {
	const names = policy.mode === "allow-list" ? checkedNames(policy.names) : [];
	const lines = [
		`port=${EGRESS_DNS_PORT}`,
		`listen-address=${env.gateway}`,
		"bind-interfaces",
		`no-dhcp-interface=${env.bridge}`,
		"no-resolv",
		"no-hosts",
		"strict-order",
		"stop-dns-rebind",
		"max-cache-ttl=300",
		"max-ttl=300",
		"user=nobody",
		"group=nogroup",
		`server=/#/127.0.0.1#${env.counterDnsPort}`,
		`server=/incus/${env.gateway}`,
		"rebind-domain-ok=/incus/",
	];
	for (const n of names) {
		lines.push(
			`server=/${n}/${env.upstream}`,
			`nftset=/${n}/4#inet#portikus_egress#names_v4`,
		);
	}
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
