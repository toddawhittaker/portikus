/**
 * The egress policy's validation and explanation (issue #284; SPEC.md section
 * 24.9): names cover their subdomains and nothing else, URLs, wildcards and
 * addresses are never host entries, and a range may not touch a denied range.
 */
import { describe, expect, test } from "vitest";
import {
	EGRESS_PRESETS,
	EgressApplyPolicy,
	EgressBlockedSiteRequest,
	EgressEntryRequest,
	EgressHost,
	type EgressPolicy,
	EgressPortsRequest,
	EgressPresetId,
	EgressPresetsRequest,
	EgressRange,
	expandEgressPolicy,
	explainHost,
	parseIpv4Cidr,
} from "./egress.js";

const allowList = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
	mode: "allow-list",
	presets: [],
	ports: [22, 80, 443],
	entries: [],
	blockedSites: [],
	...over,
});

describe("host names", () => {
	test.each(["github.com", "api.github.com", "a-b.example.edu", "x1.co"])(
		"accepts %s",
		(v) => expect(EgressHost.safeParse(v).success).toBe(true),
	);
	test("lower-cases and trims", () => {
		expect(EgressHost.parse("  GitHub.COM ")).toBe("github.com");
	});
	test.each([
		"https://github.com",
		"github.com/path",
		"*.github.com",
		"github.*",
		"localhost",
		"203.0.113.5",
		"1.2.3.4.5",
		"-bad.com",
		"bad-.com",
		"a..com",
		".github.com",
		"github.com.",
		"git_hub.com",
		"github.com:443",
		"",
		`${"a".repeat(64)}.com`,
		`${"abcdefghi.".repeat(26)}com`,
	])("refuses %s", (v) => expect(EgressHost.safeParse(v).success).toBe(false));
});

describe("ranges", () => {
	test("accepts a public range", () => {
		expect(EgressRange.safeParse("203.0.113.0/24").success).toBe(true);
		expect(EgressRange.safeParse("8.8.8.8/32").success).toBe(true);
	});
	test.each([
		"203.0.113.1/24", // host bits set
		"203.0.113.0/33",
		"203.0.113.0",
		"2001:db8::/32",
		"256.0.0.0/8",
		"01.2.3.0/24",
		"github.com/24",
	])("refuses malformed %s", (v) =>
		expect(EgressRange.safeParse(v).success).toBe(false),
	);
	test.each([
		"10.1.0.0/16",
		"192.168.1.0/24",
		"172.20.0.0/16",
		"100.64.0.0/10",
		"169.254.169.254/32",
		"0.0.0.0/0",
		"8.0.0.0/6", // covers 10.0.0.0/8
		"224.0.0.0/3",
	])("refuses %s, which overlaps a denied range", (v) => {
		const r = EgressRange.safeParse(v);
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toMatch(/private range/);
	});
	test("a range next to a denied one is fine", () => {
		expect(EgressRange.safeParse("11.0.0.0/8").success).toBe(true);
		expect(EgressRange.safeParse("9.0.0.0/8").success).toBe(true);
	});
	test("parses first and last", () => {
		expect(parseIpv4Cidr("1.2.3.0/24")).toEqual({
			first: 0x01020300,
			last: 0x010203ff,
		});
	});
});

describe("requests and limits", () => {
	test("an entry request is typed by kind", () => {
		expect(
			EgressEntryRequest.safeParse({
				version: 0,
				kind: "host",
				value: "10.0.0.0/8",
				label: "",
			}).success,
		).toBe(false);
		expect(
			EgressEntryRequest.safeParse({
				version: 0,
				kind: "range",
				value: "github.com",
				label: "",
			}).success,
		).toBe(false);
		expect(
			EgressEntryRequest.safeParse({
				version: 0,
				kind: "host",
				value: "github.com",
				label: "x".repeat(81),
			}).success,
		).toBe(false);
		expect(
			EgressEntryRequest.safeParse({ kind: "host", value: "github.com", label: "" })
				.success,
		).toBe(false);
	});
	test("ports are 1 to 65535, unique, at most 20, at least one", () => {
		const ok = (ports: number[]) =>
			EgressPortsRequest.safeParse({ version: 1, ports }).success;
		expect(ok([22, 80, 443])).toBe(true);
		expect(ok([0])).toBe(false);
		expect(ok([65536])).toBe(false);
		expect(ok([80, 80])).toBe(false);
		expect(ok([])).toBe(false);
		expect(ok(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(true);
		expect(ok(Array.from({ length: 21 }, (_, i) => i + 1))).toBe(false);
	});
	test("presets must be known and unique", () => {
		expect(
			EgressPresetsRequest.safeParse({ version: 0, presets: ["github"] }).success,
		).toBe(true);
		expect(
			EgressPresetsRequest.safeParse({ version: 0, presets: ["evil"] }).success,
		).toBe(false);
		expect(
			EgressPresetsRequest.safeParse({ version: 0, presets: ["github", "github"] })
				.success,
		).toBe(false);
	});
	test("every preset id has a catalogue entry of valid names", () => {
		expect(EGRESS_PRESETS.map((p) => p.id).sort()).toEqual(
			[...EgressPresetId.options].sort(),
		);
		for (const p of EGRESS_PRESETS)
			for (const h of p.hosts) expect(EgressHost.parse(h)).toBe(h);
	});
});

describe("explainHost", () => {
	const github = allowList({ presets: ["github"] });

	test("open mode allows any valid name", () => {
		expect(explainHost({ ...github, mode: "open" }, "example.com")).toEqual({
			allowed: true,
			reason: "open",
		});
	});
	test("a preset covers its entries and their subdomains", () => {
		expect(explainHost(github, "api.github.com")).toEqual({
			allowed: true,
			reason: "preset",
			preset: "github",
			presetLabel: "GitHub",
			entry: "github.com",
		});
		expect(explainHost(github, "GitHub.com").allowed).toBe(true);
	});
	test.each(["evilgithub.com", "github.com.evil.com", "github.co", "hub.com"])(
		"a lookalike %s is not listed",
		(v) =>
			expect(explainHost(github, v)).toEqual({ allowed: false, reason: "not-listed" }),
	);
	test("a disabled preset does not count", () => {
		expect(explainHost(allowList(), "github.com").reason).toBe("not-listed");
	});
	test("an entry covers itself and subdomains, with its label", () => {
		const p = allowList({
			entries: [{ kind: "host", value: "example.edu", label: "Campus" }],
		});
		expect(explainHost(p, "api.example.edu")).toEqual({
			allowed: true,
			reason: "entry",
			entry: "example.edu",
			label: "Campus",
		});
		expect(explainHost(p, "example.edu.evil.com").allowed).toBe(false);
	});
	test("an entry for a subdomain does not cover its parent", () => {
		const p = allowList({
			entries: [{ kind: "host", value: "api.example.edu", label: "" }],
		});
		expect(explainHost(p, "example.edu").allowed).toBe(false);
	});
	test("an address is allowed only by a range", () => {
		const p = allowList({
			presets: ["github"],
			entries: [{ kind: "range", value: "203.0.113.0/24", label: "Lab" }],
		});
		expect(explainHost(p, "203.0.113.9")).toEqual({
			allowed: true,
			reason: "range",
			range: "203.0.113.0/24",
			label: "Lab",
		});
		expect(explainHost(p, "198.51.100.1")).toEqual({
			allowed: false,
			reason: "address",
		});
	});
	test("a private address is denied in both modes", () => {
		for (const mode of ["open", "allow-list"] as const) {
			expect(explainHost(allowList({ mode }), "10.1.2.3")).toEqual({
				allowed: false,
				reason: "denied",
				range: "10.0.0.0/8",
			});
		}
		expect(explainHost(allowList({ mode: "open" }), "8.8.8.8").reason).toBe("open");
	});
	test.each(["https://github.com", "*.github.com", "github.com/x", "", "::1"])(
		"%s is not a valid host name",
		(v) =>
			expect(explainHost(github, v)).toEqual({ allowed: false, reason: "invalid" }),
	);
});

test("expandEgressPolicy expands presets and sorts", () => {
	expect(
		expandEgressPolicy(
			allowList({
				presets: ["gitlab", "github"],
				ports: [443, 22],
				entries: [
					{ kind: "host", value: "github.com", label: "" },
					{ kind: "range", value: "203.0.113.0/24", label: "" },
					{ kind: "host", value: "example.edu", label: "" },
				],
			}),
		),
	).toEqual({
		mode: "allow-list",
		names: [
			"example.edu",
			"ghcr.io",
			"github.com",
			"githubusercontent.com",
			"gitlab.com",
		],
		ranges: ["203.0.113.0/24"],
		ports: [22, 443],
		blocked: [],
	});
});

describe("blocked sites (ADR 0043)", () => {
	const open = allowList({
		mode: "open",
		blockedSites: [
			{ value: "games.com", label: "Games" },
			{ value: "dns.google", label: "" },
		],
	});

	test("explainHost refuses a blocked site and its subdomains in open mode, with the label", () => {
		expect(explainHost(open, "play.games.com")).toEqual({
			allowed: false,
			reason: "blocked",
			entry: "games.com",
			label: "Games",
		});
		expect(explainHost(open, "DNS.Google").reason).toBe("blocked");
		expect(explainHost(open, "notgames.com")).toEqual({
			allowed: true,
			reason: "open",
		});
		expect(explainHost(open, "games.com.evil.net").allowed).toBe(true);
	});

	test("allow-list mode ignores the blocked sites", () => {
		const list = { ...open, mode: "allow-list" as const };
		expect(explainHost(list, "games.com").reason).toBe("not-listed");
		expect(expandEgressPolicy(list).blocked).toEqual([]);
	});

	test("expandEgressPolicy sends the blocked names sorted in open mode", () => {
		expect(expandEgressPolicy(open).blocked).toEqual(["dns.google", "games.com"]);
	});

	test("the apply schema refuses blocked names in allow-list mode, or bad or repeated ones", () => {
		const base = { version: 1, names: [], ranges: [], ports: [443] };
		expect(
			EgressApplyPolicy.safeParse({ ...base, mode: "open", blocked: ["a.com"] })
				.success,
		).toBe(true);
		expect(
			EgressApplyPolicy.safeParse({ ...base, mode: "allow-list", blocked: ["a.com"] })
				.success,
		).toBe(false);
		for (const blocked of [
			["a.com\nserver=/#/8.8.8.8"],
			["*.a.com"],
			["a.com", "a.com"],
		]) {
			expect(
				EgressApplyPolicy.safeParse({ ...base, mode: "open", blocked }).success,
			).toBe(false);
		}
		// Absent (an older applied.json) reads as none.
		expect(EgressApplyPolicy.parse({ ...base, mode: "open" }).blocked).toEqual([]);
	});

	test("the request takes a host name only, lower-cased", () => {
		expect(
			EgressBlockedSiteRequest.parse({ version: 0, value: " Games.COM ", label: "" })
				.value,
		).toBe("games.com");
		expect(
			EgressBlockedSiteRequest.safeParse({ version: 0, value: "1.2.3.4", label: "" })
				.success,
		).toBe(false);
	});
});
