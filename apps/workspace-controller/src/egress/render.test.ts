import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EgressApplyPolicy,
	type EgressPolicy,
	expandEgressPolicy,
	explainHost,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import type { EgressEnv } from "./env.js";
import {
	GHCR_UPSTREAM_NAMES,
	HUB_UPSTREAM_NAMES,
	policyAllowsNames,
	renderDnsmasq,
	renderDropAll,
	renderSquidBlocked,
	renderSquidNames,
	renderSquidOpen,
	renderTable,
	SQUID_CONNECTIONS_PER_WORKSPACE,
	usesOurResolver,
} from "./render.js";

const CAP =
	'add rule inet portikus_egress input iifname "portikus-ws" tcp dport { 3129, 3130 } ct state new add @squid_conns { ip saddr ct count over 256 } reject with tcp reset';

const env: EgressEnv = {
	bridge: "portikus-ws",
	gateway: "10.200.0.1",
	subnet: "10.200.0.0/24",
	upstream: "127.0.0.53",
	counterDnsPort: 5399,
	deniedRanges: ["10.0.0.0/8"],
	proxyUid: 999,
};

const policy: EgressPolicy = {
	mode: "allow-list",
	presets: ["github", "npm"],
	ports: [22, 80, 443],
	entries: [
		{ kind: "host", value: "api.example.edu", label: "Course API" },
		{ kind: "range", value: "203.0.113.0/24", label: "Lab" },
	],
	blockedSites: [{ value: "games.example.com", label: "Games" }],
};

function applied(p: EgressPolicy): EgressApplyPolicy {
	return { version: 7, ...expandEgressPolicy(p) };
}

/**
 * Where dnsmasq sends a query, read back from the rendered file: the most
 * specific `server=/domain/` wins, `#` matches everything.
 */
function dnsmasqRoute(conf: string, host: string): string {
	let best: { len: number; to: string } | null = null;
	for (const line of conf.split("\n")) {
		const m = /^server=\/([^/]+)\/(.+)$/.exec(line);
		if (!m) continue;
		const domain = m[1] ?? "";
		const to = m[2] ?? "";
		const hit = domain === "#" || host === domain || host.endsWith(`.${domain}`);
		const len = domain === "#" ? 0 : domain.length;
		if (hit && (!best || len > best.len)) best = { len, to };
	}
	return best?.to ?? "none";
}

function nftsetCovers(conf: string, host: string): boolean {
	return conf.split("\n").some((l) => {
		const m = /^nftset=\/([^/]+)\/4#inet#portikus_egress#names_v4$/.exec(l);
		return m?.[1] !== undefined && (host === m[1] || host.endsWith(`.${m[1]}`));
	});
}

/** Squid's `dstdomain -n` and `ssl::server_name` with a leading dot. */
function squidCovers(names: string, host: string): boolean {
	return names
		.split("\n")
		.filter(Boolean)
		.some((l) => host === l.slice(1) || host.endsWith(l));
}

const PROBES = [
	"github.com",
	"api.github.com",
	"raw.githubusercontent.com",
	"evilgithub.com",
	"github.com.evil.net",
	"githubXcom",
	"registry.npmjs.org",
	"npmjs.org.attacker.io",
	"api.example.edu",
	"v2.api.example.edu",
	"xapi.example.edu",
	"example.edu",
	"example.com",
	"pypi.org",
];

describe("renderers agree with explainHost (issue #284, ADR 0038)", () => {
	test("allow-list: dnsmasq, the names set and Squid allow exactly what explainHost allows", () => {
		const p = applied(policy);
		const conf = renderDnsmasq(p, env);
		const names = renderSquidNames(p);
		for (const host of PROBES) {
			const allowed = explainHost(policy, host).allowed;
			const route = dnsmasqRoute(conf, host);
			expect({ host, upstream: route === env.upstream }).toEqual({
				host,
				upstream: allowed,
			});
			if (!allowed) expect(route).toBe("127.0.0.1#5399");
			expect({ host, set: nftsetCovers(conf, host) }).toEqual({ host, set: allowed });
			expect({ host, squid: squidCovers(names, host) }).toEqual({
				host,
				squid: allowed,
			});
		}
	});

	test("lookalikes are never covered", () => {
		const p = applied(policy);
		const conf = renderDnsmasq(p, env);
		for (const host of ["evilgithub.com", "github.com.evil.net", "notnpmjs.org"]) {
			expect(explainHost(policy, host).allowed).toBe(false);
			expect(dnsmasqRoute(conf, host)).toBe("127.0.0.1#5399");
			expect(squidCovers(renderSquidNames(p), host)).toBe(false);
		}
	});

	test(".incus names stay with Incus's own resolver", () => {
		const conf = renderDnsmasq(applied(policy), env);
		expect(dnsmasqRoute(conf, "ws-1.incus")).toBe("10.200.0.1");
	});

	test("open mode with blocked sites: dnsmasq and Squid refuse exactly what explainHost refuses", () => {
		const openPolicy: EgressPolicy = {
			...policy,
			mode: "open",
			blockedSites: [
				{ value: "github.com", label: "" },
				{ value: "api.example.edu", label: "" },
			],
		};
		const p = applied(openPolicy);
		const conf = renderDnsmasq(p, env);
		const blocked = renderSquidBlocked(p);
		expect(nftsetCovers(conf, "github.com")).toBe(false);
		expect(renderSquidNames(p)).toBe("");
		expect(renderSquidOpen(p)).toBe(".\n");
		for (const host of PROBES) {
			const e = explainHost(openPolicy, host);
			if (e.reason === "invalid") continue;
			const route = dnsmasqRoute(conf, host);
			expect({ host, upstream: route === env.upstream }).toEqual({
				host,
				upstream: e.allowed,
			});
			if (!e.allowed) {
				expect(e.reason).toBe("blocked");
				expect(route).toBe("127.0.0.1#5399");
			}
			expect({ host, squid: squidCovers(blocked, host) }).toEqual({
				host,
				squid: !e.allowed,
			});
		}
		expect(dnsmasqRoute(conf, "ws-1.incus")).toBe("10.200.0.1");
	});

	test("allow-list mode ignores the blocked sites", () => {
		const p = applied(policy);
		expect(p.blocked).toEqual([]);
		expect(renderSquidBlocked(p)).toBe("");
		expect(renderSquidOpen(p)).toBe("");
		expect(explainHost(policy, "games.example.com").reason).toBe("not-listed");
	});

	test("open mode: no names in dnsmasq or Squid, empty chains", () => {
		const open = applied({ ...policy, mode: "open", blockedSites: [] });
		expect(usesOurResolver(open)).toBe(false);
		expect(renderSquidBlocked(open)).toBe("");
		expect(renderSquidOpen(open)).toBe("");
		expect(renderSquidNames(open)).toBe("");
		const conf = renderDnsmasq(open, env);
		expect(conf).not.toMatch(/github/);
		// The helper stops our dnsmasq here; the file would only forward everything.
		expect(dnsmasqRoute(conf, "github.com")).toBe(env.upstream);
		const table = renderTable(open, env, true, false);
		expect(table).not.toMatch(/^add rule/m);
		expect(table).not.toMatch(/^add element/m);
		for (const host of PROBES) {
			const e = explainHost({ ...policy, mode: "open", blockedSites: [] }, host);
			if (e.reason !== "invalid") expect(e.allowed).toBe(true);
		}
	});
});

describe("renderDnsmasq", () => {
	test("is the fixed base file, then one server and nftset line per listed name", () => {
		const conf = renderDnsmasq(
			{ mode: "allow-list", names: ["github.com"], blocked: [] },
			{ ...env, gateway: "10.9.0.1", bridge: "br-x", upstream: "10.9.0.53" },
		);
		expect(conf).toBe(
			[
				"port=5300",
				"listen-address=10.9.0.1",
				"bind-interfaces",
				"no-dhcp-interface=br-x",
				"no-resolv",
				"no-hosts",
				"strict-order",
				"stop-dns-rebind",
				"max-cache-ttl=300",
				"max-ttl=300",
				"user=nobody",
				"group=nogroup",
				"server=/#/127.0.0.1#5399",
				"server=/incus/10.9.0.1",
				"rebind-domain-ok=/incus/",
				"server=/github.com/10.9.0.53",
				"nftset=/github.com/4#inet#portikus_egress#names_v4",
				"",
			].join("\n"),
		);
	});

	test.each([
		"evil.com\nserver=/#/8.8.8.8",
		"evil.com/8.8.8.8",
		"evil .com",
		"evil.com#53",
		"*.evil.com",
		"https://evil.com",
		"1.2.3.4",
	])("refuses to render %j", (bad) => {
		expect(() =>
			renderDnsmasq({ mode: "allow-list", names: [bad], blocked: [] }, env),
		).toThrow();
		expect(() =>
			renderDnsmasq({ mode: "open", names: [], blocked: [bad] }, env),
		).toThrow();
		expect(() => renderSquidBlocked({ mode: "open", blocked: [bad] })).toThrow();
		expect(() => renderSquidNames({ mode: "allow-list", names: [bad] })).toThrow();
	});
});

describe("renderTable", () => {
	test("allow-list: DNS redirect first, ranges, Squid redirects, then the forward rules", () => {
		const t = renderTable(applied(policy), env, false, false);
		const rules = t.split("\n").filter((l) => l.startsWith("add rule"));
		expect(rules).toEqual([
			'add rule inet portikus_egress input iifname "portikus-ws" tcp dport 5000 drop',
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 redirect to :5300',
			"add rule inet portikus_egress output meta skuid 999 ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 dnat ip to 10.200.0.1:5300",
			CAP,
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr @ranges_v4 return',
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr @names_v4 tcp dport 443 redirect to :3130',
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr @names_v4 tcp dport 80 redirect to :3129',
			'add rule inet portikus_egress forward iifname "portikus-ws" meta l4proto { tcp, udp } th dport { 53, 853 } drop',
			'add rule inet portikus_egress forward iifname "portikus-ws" ip daddr @ranges_v4 tcp dport @ports accept',
			'add rule inet portikus_egress forward iifname "portikus-ws" ip daddr @names_v4 tcp dport @ports accept',
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
		expect(t).toContain(
			"add element inet portikus_egress ranges_v4 { 203.0.113.0/24 }",
		);
		expect(t).toContain("add element inet portikus_egress ports { 22, 80, 443 }");
		// The names set has no timeout and a size bound (ADR 0038).
		expect(t).toMatch(/set names_v4 \{\n\t\ttype ipv4_addr\n\t\tsize 65535\n\t\}/);
		expect(t).not.toMatch(/timeout/);
	});

	test("open mode with blocked sites: both DNS rules, every public web port to Squid, outside DNS dropped", () => {
		const t = renderTable(applied({ ...policy, mode: "open" }), env, true, false);
		expect(t.split("\n").filter((l) => l.startsWith("add rule"))).toEqual([
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 redirect to :5300',
			"add rule inet portikus_egress output meta skuid 999 ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 dnat ip to 10.200.0.1:5300",
			CAP,
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr != { 10.0.0.0/8 } tcp dport 443 redirect to :3130',
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr != { 10.0.0.0/8 } tcp dport 80 redirect to :3129',
			'add rule inet portikus_egress forward iifname "portikus-ws" meta l4proto { tcp, udp } th dport { 53, 853 } drop',
			'add rule inet portikus_egress forward iifname "portikus-ws" udp dport 443 drop',
		]);
		// Nothing else is dropped: open mode stays open apart from the blocked names.
		expect(t).not.toMatch(/forward iifname "portikus-ws" drop/);
		expect(t).not.toMatch(/^add element/m);
	});

	test("open mode with blocked sites refuses a malformed denied range from egress.env", () => {
		expect(() =>
			renderTable(
				applied({ ...policy, mode: "open" }),
				{ ...env, deniedRanges: ["10.0.0.0/8 } accept"] },
				true,
				false,
			),
		).toThrow();
	});

	// One workspace must not exhaust the Squid every workspace shares.
	test("caps each workspace's connections to Squid whenever Squid is in the path", () => {
		const open = applied({ ...policy, mode: "open" });
		for (const p of [applied(policy), open]) {
			const t = renderTable(p, env, false, false);
			expect(
				t
					.split("\n")
					.filter((l) => l.startsWith("add rule inet portikus_egress input"))
					.filter((l) => !/dport 500[01] drop$/.test(l)),
			).toEqual([CAP]);
			expect(t).toMatch(/^flush chain inet portikus_egress input$/m);
		}
		const plain = renderTable(
			applied({ ...policy, mode: "open", blockedSites: [] }),
			env,
			false,
			false,
		);
		expect(plain).not.toContain("ct count");
		expect(SQUID_CONNECTIONS_PER_WORKSPACE).toBe(256);
	});

	// Squid looks up the Host a workspace sent; through Incus's resolver any
	// name would reach the internet, a channel out for data (ADR 0038).
	test("the workspace proxy's own DNS goes to our dnsmasq, and only its own", () => {
		const t = renderTable(applied(policy), env, false, false);
		const output = t
			.split("\n")
			.filter((l) => l.startsWith("add rule inet portikus_egress output"));
		expect(output).toEqual([
			"add rule inet portikus_egress output meta skuid 999 ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 dnat ip to 10.200.0.1:5300",
		]);
		expect(t).toMatch(
			/chain output \{\n\t\ttype nat hook output priority dstnat - 1\n\t\}/,
		);
		expect(t).toMatch(/^flush chain inet portikus_egress output$/m);
	});

	test("open mode with no blocked site sends no DNS to our dnsmasq, and redirects nothing", () => {
		const t = renderTable(
			applied({ ...policy, mode: "open", blockedSites: [] }),
			env,
			true,
			false,
		);
		expect(t).not.toMatch(/add rule/);
		expect(t).toMatch(/^flush chain inet portikus_egress output$/m);
	});

	test("a port left out of the list gets no Squid redirect", () => {
		const t = renderTable({ ...applied(policy), ports: [22] }, env, false, false);
		expect(t).not.toMatch(/dport 443 redirect/);
		expect(t).not.toMatch(/dport 80 redirect/);
	});

	test("flushes the names set only when asked; always resets the rest", () => {
		expect(renderTable(applied(policy), env, false, false)).not.toMatch(
			/flush set .* names_v4/,
		);
		const t = renderTable(applied(policy), env, true, false);
		expect(t).toMatch(/^flush set inet portikus_egress names_v4$/m);
		expect(t).toMatch(/^flush chain inet portikus_egress forward$/m);
	});

	test("no range means no ranges element line", () => {
		const t = renderTable({ ...applied(policy), ranges: [] }, env, false, false);
		expect(t).not.toMatch(/add element .* ranges_v4/);
	});

	test("refuses a malformed range or port", () => {
		const p = applied(policy);
		expect(() =>
			renderTable({ ...p, ranges: ["1.2.3.0/24 }; flush ruleset"] }, env, false, false),
		).toThrow();
		expect(() => renderTable({ ...p, ports: [0] }, env, false, false)).toThrow();
	});

	test("drop-all drops every forwarded packet from the bridge and redirects nothing", () => {
		const t = renderDropAll(env);
		expect(t.split("\n").filter((l) => l.startsWith("add rule"))).toEqual([
			'add rule inet portikus_egress input iifname "portikus-ws" tcp dport { 5000, 5001 } drop',
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
	});

	// The helper's guard loads Ansible's copy when the helper cannot run at all.
	test("Ansible's drop-all file is the same table", () => {
		const template = readFileSync(
			new URL(
				"../../../../infra/ansible/roles/workspace_egress/templates/egress-drop-all.nft.j2",
				import.meta.url,
			),
			"utf8",
		);
		const rendered = template
			.split("\n")
			.filter((l) => !l.startsWith("#"))
			.join("\n")
			.replaceAll("{{ workspace_egress_bridge }}", env.bridge);
		expect(rendered).toBe(renderDropAll(env));
	});
});

// Loads each rendering with the real nft inside an unprivileged network
// namespace, twice, to prove the syntax and that a reload is accepted.
function nftAvailable(): boolean {
	try {
		execFileSync("unshare", ["-rn", "/usr/sbin/nft", "list", "ruleset"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!nftAvailable())("the real nft accepts every rendering", () => {
	test.each([
		["allow-list", () => renderTable(applied(policy), env, true, false)],
		["allow-list, keep names", () => renderTable(applied(policy), env, false, false)],
		[
			"open",
			() =>
				renderTable(
					applied({ ...policy, mode: "open", blockedSites: [] }),
					env,
					true,
					false,
				),
		],
		[
			"open with blocked sites",
			() =>
				renderTable(
					applied({ ...policy, mode: "open" }),
					{ ...env, deniedRanges: ["10.0.0.0/8", "192.168.0.0/16", "224.0.0.0/4"] },
					true,
					false,
				),
		],
		["drop-all", () => renderDropAll(env)],
	])("%s", (_name, render) => {
		const dir = mkdtempSync(join(tmpdir(), "egress-nft-"));
		const file = join(dir, "t.nft");
		writeFileSync(file, render());
		const out = execFileSync(
			"unshare",
			[
				"-rn",
				"sh",
				"-c",
				`nft -f "$1" && nft -f "$1" && nft list table inet portikus_egress`,
				"sh",
				file,
			],
			{ encoding: "utf8" },
		);
		expect(out).toContain("table inet portikus_egress");
	});
});

function dnsmasqAvailable(): boolean {
	try {
		execFileSync("/usr/sbin/dnsmasq", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!dnsmasqAvailable())("the real dnsmasq accepts the rendering", () => {
	test("dnsmasq --test", () => {
		const dir = mkdtempSync(join(tmpdir(), "egress-dnsmasq-"));
		const file = join(dir, "dnsmasq.conf");
		writeFileSync(file, renderDnsmasq(applied(policy), env));
		// Throws on a non-zero exit, which is a syntax error.
		execFileSync("/usr/sbin/dnsmasq", ["--test", `--conf-file=${file}`], {
			stdio: "pipe",
		});
	});

	test("dnsmasq --test, open mode with blocked sites", () => {
		const dir = mkdtempSync(join(tmpdir(), "egress-dnsmasq-"));
		const file = join(dir, "dnsmasq.conf");
		writeFileSync(file, renderDnsmasq(applied({ ...policy, mode: "open" }), env));
		execFileSync("/usr/sbin/dnsmasq", ["--test", `--conf-file=${file}`], {
			stdio: "pipe",
		});
	});
});

describe("the registry caches' gate and the ghcr.io redirect (issue #840)", () => {
	const HUB_DROP =
		'add rule inet portikus_egress input iifname "portikus-ws" tcp dport 5000 drop';
	const GHCR_DROP =
		'add rule inet portikus_egress input iifname "portikus-ws" tcp dport 5001 drop';
	const REDIRECT =
		'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr 10.200.0.1 tcp dport 443 redirect to :5001';
	const hub = [...HUB_UPSTREAM_NAMES];
	const ghcr = [...GHCR_UPSTREAM_NAMES];
	// Without the GitHub preset, which lists ghcr.io and githubusercontent.com.
	const bare: EgressPolicy = { ...policy, presets: ["npm"] };

	function withNames(names: string[]): EgressApplyPolicy {
		return { ...applied(policy), names };
	}

	function inputLines(t: string): string[] {
		return t
			.split("\n")
			.filter((l) => l.startsWith("add rule inet portikus_egress input"));
	}

	test("allow-list mode drops both cache ports unless every upstream name is listed", () => {
		const t = renderTable(applied(bare), env, true, false);
		expect(t).toContain(HUB_DROP);
		expect(t).toContain(GHCR_DROP);
		// The GitHub preset lists every ghcr.io name, so it opens that cache.
		const github = renderTable(applied(policy), env, true, false);
		expect(github).toContain(HUB_DROP);
		expect(github).not.toContain(GHCR_DROP);
		// Two of the three Hub names are not enough: a pull needs all of them.
		expect(renderTable(withNames(hub.slice(0, 2)), env, true, false)).toContain(
			HUB_DROP,
		);
	});

	test("allow-list mode opens a cache port when its names, or a parent, are listed", () => {
		const both = renderTable(withNames([...hub, ...ghcr]), env, true, false);
		expect(both).not.toContain(HUB_DROP);
		expect(both).not.toContain(GHCR_DROP);
		const parents = renderTable(
			withNames(["docker.com", "docker.io", "ghcr.io", "githubusercontent.com"]),
			env,
			true,
			false,
		);
		expect(parents).not.toContain(HUB_DROP);
		expect(parents).not.toContain(GHCR_DROP);
		const hubOnly = renderTable(withNames(hub), env, true, false);
		expect(hubOnly).not.toContain(HUB_DROP);
		expect(hubOnly).toContain(GHCR_DROP);
	});

	test("open mode drops a cache port only when a blocked site covers one of its names", () => {
		const open = applied({ ...policy, mode: "open", blockedSites: [] });
		const plain = renderTable(open, env, true, false);
		expect(plain).not.toContain(HUB_DROP);
		expect(plain).not.toContain(GHCR_DROP);
		const blocksHub = renderTable(
			{ ...open, blocked: ["docker.com"] },
			env,
			true,
			false,
		);
		expect(blocksHub).toContain(HUB_DROP);
		expect(blocksHub).not.toContain(GHCR_DROP);
		const blocksGhcr = renderTable({ ...open, blocked: ["ghcr.io"] }, env, true, false);
		expect(blocksGhcr).toContain(GHCR_DROP);
		expect(blocksGhcr).not.toContain(HUB_DROP);
		// A blocked site elsewhere leaves the caches open.
		const elsewhere = renderTable(
			applied({ ...policy, mode: "open" }),
			env,
			true,
			false,
		);
		expect(elsewhere).not.toContain(HUB_DROP);
	});

	test("the gate drops every packet and nothing in input accepts ahead of it", () => {
		const open: EgressApplyPolicy = {
			...applied({ ...policy, mode: "open" }),
			blocked: ["docker.com", "ghcr.io"],
		};
		for (const p of [applied(bare), open]) {
			const lines = inputLines(renderTable(p, env, true, true));
			expect(lines.slice(0, 2)).toEqual([HUB_DROP, GHCR_DROP]);
			expect(lines.join("\n")).not.toMatch(/accept|established/);
			expect(lines.slice(2)).toEqual([CAP]);
		}
	});

	test("the ghcr.io redirect is rendered only while the cache is on, in every mode", () => {
		const modes = [
			applied(policy),
			applied({ ...policy, mode: "open" }),
			applied({ ...policy, mode: "open", blockedSites: [] }),
		];
		for (const p of modes) {
			const pre = renderTable(p, env, true, true)
				.split("\n")
				.filter((l) => l.includes(" prerouting "));
			// First, ahead of any redirect to Squid that could take gateway 443.
			expect(pre.find((l) => l.includes("redirect"))).toBe(REDIRECT);
			expect(renderTable(p, env, true, false)).not.toContain("redirect to :5001");
		}
		// Redirected but not allowed: the gate still drops 5001.
		expect(renderTable(applied(bare), env, true, true)).toContain(GHCR_DROP);
	});

	test("drop-all closes both cache ports", () => {
		expect(renderDropAll(env)).toContain(
			'add rule inet portikus_egress input iifname "portikus-ws" tcp dport { 5000, 5001 } drop',
		);
	});

	test("the name matcher agrees with the admin page's explanation", () => {
		for (const host of [...hub, ...ghcr]) {
			for (const listed of ["docker.com", "docker.io", "ghcr.io", host]) {
				const p: EgressPolicy = {
					...policy,
					presets: [],
					entries: [{ kind: "host", value: listed, label: "x" }],
				};
				expect(policyAllowsNames(applied(p), [host])).toBe(
					explainHost(p, host).allowed,
				);
			}
		}
	});
});
