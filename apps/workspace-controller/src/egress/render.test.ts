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
	renderDnsmasq,
	renderDropAll,
	renderSquidNames,
	renderTable,
} from "./render.js";

const env: EgressEnv = {
	bridge: "portikus-ws",
	gateway: "10.200.0.1",
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

	test("open mode: no names in dnsmasq or Squid, empty chains", () => {
		const open = applied({ ...policy, mode: "open" });
		expect(renderSquidNames(open)).toBe("");
		const conf = renderDnsmasq(open, env);
		expect(conf).not.toMatch(/github/);
		expect(dnsmasqRoute(conf, "github.com")).toBe("127.0.0.1#5399");
		const table = renderTable(open, env, true);
		expect(table).not.toMatch(/^add rule/m);
		expect(table).not.toMatch(/^add element/m);
		for (const host of PROBES) {
			const e = explainHost({ ...policy, mode: "open" }, host);
			if (e.reason !== "invalid") expect(e.allowed).toBe(true);
		}
	});
});

describe("renderDnsmasq", () => {
	test("is the fixed base file, then one server and nftset line per listed name", () => {
		const conf = renderDnsmasq(
			{ mode: "allow-list", names: ["github.com"] },
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
		expect(() => renderDnsmasq({ mode: "allow-list", names: [bad] }, env)).toThrow();
		expect(() => renderSquidNames({ mode: "allow-list", names: [bad] })).toThrow();
	});
});

describe("renderTable", () => {
	test("allow-list: DNS redirect first, ranges, Squid redirects, then the forward rules", () => {
		const t = renderTable(applied(policy), env, false);
		const rules = t.split("\n").filter((l) => l.startsWith("add rule"));
		expect(rules).toEqual([
			'add rule inet portikus_egress prerouting iifname "portikus-ws" ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 redirect to :5300',
			"add rule inet portikus_egress output meta skuid 999 ip daddr 10.200.0.1 meta l4proto { tcp, udp } th dport 53 dnat ip to 10.200.0.1:5300",
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

	// Squid looks up the Host a workspace sent; through Incus's resolver any
	// name would reach the internet, a channel out for data (ADR 0038).
	test("the workspace proxy's own DNS goes to our dnsmasq, and only its own", () => {
		const t = renderTable(applied(policy), env, false);
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

	test("open mode sends no DNS to our dnsmasq, and redirects nothing", () => {
		const t = renderTable(applied({ ...policy, mode: "open" }), env, true);
		expect(t).not.toMatch(/add rule/);
		expect(t).toMatch(/^flush chain inet portikus_egress output$/m);
	});

	test("a port left out of the list gets no Squid redirect", () => {
		const t = renderTable({ ...applied(policy), ports: [22] }, env, false);
		expect(t).not.toMatch(/dport 443 redirect/);
		expect(t).not.toMatch(/dport 80 redirect/);
	});

	test("flushes the names set only when asked; always resets the rest", () => {
		expect(renderTable(applied(policy), env, false)).not.toMatch(
			/flush set .* names_v4/,
		);
		const t = renderTable(applied(policy), env, true);
		expect(t).toMatch(/^flush set inet portikus_egress names_v4$/m);
		expect(t).toMatch(/^flush chain inet portikus_egress forward$/m);
	});

	test("no range means no ranges element line", () => {
		const t = renderTable({ ...applied(policy), ranges: [] }, env, false);
		expect(t).not.toMatch(/add element .* ranges_v4/);
	});

	test("refuses a malformed range or port", () => {
		const p = applied(policy);
		expect(() =>
			renderTable({ ...p, ranges: ["1.2.3.0/24 }; flush ruleset"] }, env, false),
		).toThrow();
		expect(() => renderTable({ ...p, ports: [0] }, env, false)).toThrow();
	});

	test("drop-all drops every forwarded packet from the bridge and redirects nothing", () => {
		const t = renderDropAll(env);
		expect(t.split("\n").filter((l) => l.startsWith("add rule"))).toEqual([
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
		["allow-list", () => renderTable(applied(policy), env, true)],
		["allow-list, keep names", () => renderTable(applied(policy), env, false)],
		["open", () => renderTable(applied({ ...policy, mode: "open" }), env, true)],
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
});
