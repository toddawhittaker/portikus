import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressApplyPolicy } from "@portikus/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { parseEgressEnv } from "./env.js";
import {
	defaultRunner,
	type HelperDeps,
	MAX_REQUEST_BYTES,
	type RunResult,
	runHelper,
} from "./helper.js";

const ENV_TEXT = [
	"# written by Ansible",
	"EGRESS_BRIDGE=portikus-ws",
	"EGRESS_GATEWAY=10.200.0.1",
	"EGRESS_UPSTREAM=127.0.0.53",
	"EGRESS_COUNTER_DNS_PORT=5399",
	"EGRESS_DENIED_RANGES=10.0.0.0/8,192.168.0.0/16,198.18.0.0/15",
	"",
].join("\n");

describe("parseEgressEnv", () => {
	test("reads every key", () => {
		expect(parseEgressEnv(ENV_TEXT)).toEqual({
			bridge: "portikus-ws",
			gateway: "10.200.0.1",
			upstream: "127.0.0.53",
			counterDnsPort: 5399,
			deniedRanges: ["10.0.0.0/8", "192.168.0.0/16", "198.18.0.0/15"],
		});
	});

	test.each([
		["an unknown key", `${ENV_TEXT}EGRESS_EXTRA=1\n`],
		["a repeated key", `${ENV_TEXT}EGRESS_BRIDGE=portikus-ws\n`],
		["a missing key", ENV_TEXT.replace(/EGRESS_UPSTREAM=.*\n/, "")],
		["a line without =", `${ENV_TEXT}oops\n`],
		["a bridge with a quote", ENV_TEXT.replace("=portikus-ws", '=portikus-ws" drop')],
		[
			"a bridge that is too long",
			ENV_TEXT.replace("=portikus-ws", "=a-very-long-bridge-name"),
		],
		["a gateway that is a name", ENV_TEXT.replace("=10.200.0.1", "=gateway")],
		["an upstream with a port", ENV_TEXT.replace("=127.0.0.53", "=127.0.0.53#53")],
		["a port out of range", ENV_TEXT.replace("=5399", "=70000")],
		[
			"a denied range that is not one",
			ENV_TEXT.replace("198.18.0.0/15", "198.18.0.1/15"),
		],
	])("refuses %s", (_what, text) => {
		expect(() => parseEgressEnv(text)).toThrow();
	});
});

interface Call {
	file: string;
	args: string[];
	input?: string;
}

let dir: string;
let deps: HelperDeps;
let calls: Call[];
/** Answer for a call, by "file arg0"; default success. */
let answers: Map<string, RunResult>;
let tableLoadedNow: boolean;
/** Snapshot of files at each systemctl call, to check ordering. */
let seenAtCall: Array<{ call: string; dnsmasq: string | null; names: string | null }>;

const state = (f: string) => join(dir, "state", f);
const read = (f: string): string | null =>
	existsSync(state(f)) ? readFileSync(state(f), "utf8") : null;

function policy(over: Partial<EgressApplyPolicy> = {}): EgressApplyPolicy {
	return {
		version: 3,
		mode: "allow-list",
		names: ["github.com", "npmjs.org"],
		ranges: ["203.0.113.0/24"],
		ports: [22, 80, 443],
		blocked: [],
		...over,
	};
}

function writeRequest(body: unknown, requestId = "req-1"): void {
	writeFileSync(deps.requestPath, JSON.stringify({ requestId, ...(body as object) }));
}

function status(): { requestId: string | null; ok: boolean; error: string | null } {
	return JSON.parse(read("status.json") ?? "null");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "egress-helper-"));
	mkdirSync(join(dir, "request"));
	writeFileSync(join(dir, "egress.env"), ENV_TEXT, { mode: 0o644 });
	calls = [];
	answers = new Map();
	tableLoadedNow = true;
	seenAtCall = [];
	deps = {
		requestPath: join(dir, "request", "request.json"),
		stateDir: join(dir, "state"),
		envPath: join(dir, "egress.env"),
		now: () => new Date("2026-09-27T12:00:00Z"),
		allowAnyOwner: true,
		run: async (file, args, input) => {
			calls.push({ file, args, input });
			if (file.endsWith("systemctl")) {
				seenAtCall.push({
					call: args.join(" "),
					dnsmasq: read("dnsmasq.conf"),
					names: read("names.txt"),
				});
			}
			const key = `${file.split("/").pop()} ${args[0]}`;
			if (key === "nft list") return { code: tableLoadedNow ? 0 : 1, stderr: "" };
			const a = answers.get(key);
			if (a) return a;
			if (key === "nft -f") tableLoadedNow = true;
			return { code: 0, stderr: "" };
		},
	};
});

const loads = () => calls.filter((c) => c.args[0] === "-f").map((c) => c.input ?? "");
const systemctls = () =>
	calls.filter((c) => c.file === "/usr/bin/systemctl").map((c) => c.args.join(" "));

describe("a request (ADR 0038)", () => {
	test("allow-list: the table, then dnsmasq, then Squid's list; then applied and status", async () => {
		writeRequest(policy());
		expect(await runHelper(deps)).toBe(0);

		expect(calls.map((c) => `${c.file} ${c.args[0]}`)).toEqual([
			"/usr/sbin/nft list",
			"/usr/sbin/nft -f",
			"/usr/bin/systemctl restart",
			"/usr/bin/systemctl reload",
		]);
		expect(systemctls()).toEqual([
			"restart portikus-egress-dns.service",
			"reload portikus-workspace-proxy.service",
		]);
		// dnsmasq.conf is in place before its restart; names.txt before Squid's reload, not before dnsmasq's.
		expect(seenAtCall[0]?.dnsmasq).toContain("server=/github.com/127.0.0.53");
		expect(seenAtCall[0]?.names).toBeNull();
		expect(seenAtCall[1]?.names).toBe(".github.com\n.npmjs.org\n");

		expect(loads()[0]).toMatch(/flush set inet portikus_egress names_v4/);
		expect(JSON.parse(read("applied.json") ?? "")).toEqual({
			policy: policy(),
			appliedAt: "2026-09-27T12:00:00.000Z",
			bridge: "portikus-ws",
			gateway: "10.200.0.1",
		});
		expect(status()).toEqual({
			requestId: "req-1",
			version: 3,
			ok: true,
			error: null,
			at: "2026-09-27T12:00:00.000Z",
		});
		expect(existsSync(deps.requestPath)).toBe(false);
		expect(existsSync(state("request.processing"))).toBe(false);
	});

	test("switching to open stops our dnsmasq and empties Squid's list", async () => {
		writeRequest(policy());
		await runHelper(deps);
		calls = [];
		writeRequest(policy({ version: 4, mode: "open" }), "req-2");
		expect(await runHelper(deps)).toBe(0);
		expect(systemctls()).toEqual([
			"stop portikus-egress-dns.service",
			"reload portikus-workspace-proxy.service",
		]);
		expect(loads()[0]).toMatch(/flush set inet portikus_egress names_v4/);
		expect(loads()[0]).not.toMatch(/add rule/);
		expect(read("names.txt")).toBe("");
	});

	test("open mode with blocked sites runs our dnsmasq and writes Squid's blocked list and switch (ADR 0043)", async () => {
		writeRequest(
			policy({ mode: "open", names: [], blocked: ["dns.google", "games.com"] }),
		);
		expect(await runHelper(deps)).toBe(0);
		expect(systemctls()).toEqual([
			"restart portikus-egress-dns.service",
			"reload portikus-workspace-proxy.service",
		]);
		expect(seenAtCall[0]?.dnsmasq).toContain("server=/#/127.0.0.53");
		expect(seenAtCall[0]?.dnsmasq).toContain("server=/games.com/127.0.0.1#5399");
		expect(loads()[0]).toMatch(/tcp dport 443 redirect to :3130/);
		expect(read("names.txt")).toBe("");
		expect(read("blocked.txt")).toBe(".dns.google\n.games.com\n");
		expect(read("open.txt")).toBe(".\n");

		// Emptying the list is plain open mode again: our dnsmasq stops, Squid's files empty.
		calls = [];
		writeRequest(policy({ version: 4, mode: "open", names: [], blocked: [] }), "r2");
		expect(await runHelper(deps)).toBe(0);
		expect(systemctls()[0]).toBe("stop portikus-egress-dns.service");
		expect(loads()[0]).not.toMatch(/add rule/);
		expect(read("blocked.txt")).toBe("");
		expect(read("open.txt")).toBe("");
	});

	test("blocked sites in allow-list mode are refused", async () => {
		writeRequest(policy({ blocked: ["games.com"] }));
		expect(await runHelper(deps)).toBe(1);
		expect(status().error).toBe("request refused: invalid blocked");
		expect(loads()).toEqual([]);
	});

	test("adding a name keeps learned addresses; removing one flushes them", async () => {
		writeRequest(policy());
		await runHelper(deps);
		calls = [];
		writeRequest(
			policy({ version: 4, names: ["github.com", "npmjs.org", "pypi.org"] }),
			"r2",
		);
		await runHelper(deps);
		expect(loads()[0]).not.toMatch(/flush set inet portikus_egress names_v4/);
		calls = [];
		writeRequest(policy({ version: 5, names: ["github.com"] }), "r3");
		await runHelper(deps);
		expect(loads()[0]).toMatch(/flush set inet portikus_egress names_v4/);
	});

	test("after a failed request the next one flushes, whatever it changes", async () => {
		writeRequest(policy());
		await runHelper(deps);
		answers.set("systemctl reload", { code: 1, stderr: "not running" });
		writeRequest(
			policy({ version: 4, names: ["github.com", "npmjs.org", "x.org"] }),
			"r2",
		);
		expect(await runHelper(deps)).toBe(1);
		answers.clear();
		calls = [];
		writeRequest(policy({ version: 5 }), "r3");
		await runHelper(deps);
		expect(loads()[0]).toMatch(/flush set inet portikus_egress names_v4/);
	});

	test("an nft failure stops before dnsmasq and Squid and keeps the last applied policy", async () => {
		writeRequest(policy());
		await runHelper(deps);
		const before = read("applied.json");
		calls = [];
		answers.set("nft -f", { code: 1, stderr: "Error: syntax error" });
		writeRequest(policy({ version: 4 }), "r2");
		expect(await runHelper(deps)).toBe(1);
		expect(systemctls()).toEqual([]);
		expect(read("applied.json")).toBe(before);
		expect(status()).toMatchObject({ requestId: "r2", ok: false });
		expect(status().error).toMatch(/nft refused the table: Error: syntax error/);
	});

	test("a dnsmasq restart failure stops before Squid and is reported", async () => {
		answers.set("systemctl restart", { code: 1, stderr: "failed" });
		writeRequest(policy());
		expect(await runHelper(deps)).toBe(1);
		expect(systemctls()).toEqual(["restart portikus-egress-dns.service"]);
		expect(read("applied.json")).toBeNull();
		expect(status()).toMatchObject({ requestId: "req-1", ok: false });
	});

	test("no request and a loaded table: nothing happens", async () => {
		expect(await runHelper(deps)).toBe(0);
		expect(calls.map((c) => c.args[0])).toEqual(["list"]);
		expect(read("status.json")).toBeNull();
	});
});

describe("the helper refuses a bad request and changes nothing", () => {
	const cases: Array<[string, () => void]> = [
		["text that is not JSON", () => writeFileSync(deps.requestPath, "{nope")],
		["an array", () => writeFileSync(deps.requestPath, "[]")],
		[
			"a missing request id",
			() => writeFileSync(deps.requestPath, JSON.stringify(policy())),
		],
		["a request id with a slash", () => writeRequest(policy(), "../x")],
		["an unknown key", () => writeRequest({ ...policy(), extra: 1 })],
		[
			"a name with a newline",
			() => writeRequest(policy({ names: ["a.com\nserver=/#/8.8.8.8"] })),
		],
		["a name with a slash", () => writeRequest(policy({ names: ["a.com/8.8.8.8"] }))],
		["a name with a space", () => writeRequest(policy({ names: ["a .com"] }))],
		["a wildcard", () => writeRequest(policy({ names: ["*.a.com"] }))],
		["an address as a name", () => writeRequest(policy({ names: ["1.2.3.4"] }))],
		["a duplicate name", () => writeRequest(policy({ names: ["a.com", "a.com"] }))],
		[
			"a range in a built-in denied range",
			() => writeRequest(policy({ ranges: ["10.1.0.0/16"] })),
		],
		[
			"a range in a configured denied range",
			() => writeRequest(policy({ ranges: ["198.18.0.0/24"] })),
		],
		[
			"a range with host bits",
			() => writeRequest(policy({ ranges: ["203.0.113.1/24"] })),
		],
		[
			"a range with a brace",
			() => writeRequest(policy({ ranges: ["203.0.113.0/24 }"] })),
		],
		["port 0", () => writeRequest(policy({ ports: [0] }))],
		["a string port", () => writeRequest({ ...policy(), ports: ["443"] })],
		["an unknown mode", () => writeRequest({ ...policy(), mode: "closed" })],
		[
			"an oversized file",
			() => writeFileSync(deps.requestPath, " ".repeat(MAX_REQUEST_BYTES + 1)),
		],
		[
			"a symbolic link",
			() => {
				writeFileSync(join(dir, "secret"), "root:x:0:0\n");
				symlinkSync(join(dir, "secret"), deps.requestPath);
			},
		],
	];

	test.each(cases)("%s", async (_what, plant) => {
		plant();
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toEqual([]);
		expect(systemctls()).toEqual([]);
		expect(read("applied.json")).toBeNull();
		expect(read("dnsmasq.conf")).toBeNull();
		expect(status().ok).toBe(false);
		expect(status().error).toMatch(/^request refused: /);
		// Nothing of what the file held is echoed back.
		expect(read("status.json")).not.toMatch(/root:x|8\.8\.8\.8|nope/);
		expect(existsSync(deps.requestPath)).toBe(false);
	});

	test("a refusal answers the request by its id when the id is well formed", async () => {
		writeRequest(policy({ names: ["bad name"] }), "req-9");
		await runHelper(deps);
		expect(status().requestId).toBe("req-9");
	});
});

describe("a leftover request.processing", () => {
	test("a leftover directory is removed so the helper cannot wedge", async () => {
		mkdirSync(state("request.processing"), { recursive: true });
		writeFileSync(join(state("request.processing"), "junk"), "x");
		writeRequest(policy());
		expect(await runHelper(deps)).toBe(0);
		expect(status()).toMatchObject({ requestId: "req-1", ok: true });
		expect(existsSync(state("request.processing"))).toBe(false);
	});

	test("a leftover file is replaced by the new request", async () => {
		mkdirSync(deps.stateDir, { recursive: true });
		writeFileSync(state("request.processing"), "stale");
		writeRequest(policy());
		expect(await runHelper(deps)).toBe(0);
		expect(status()).toMatchObject({ requestId: "req-1", ok: true });
	});
});

describe("the configuration file", () => {
	test("a bad egress.env refuses the request and touches nothing", async () => {
		writeFileSync(deps.envPath, `${ENV_TEXT}EGRESS_EXTRA=1\n`);
		writeRequest(policy());
		expect(await runHelper(deps)).toBe(1);
		expect(calls).toEqual([]);
		expect(status()).toMatchObject({
			ok: false,
			error: "egress.env has an unknown key",
		});
		expect(existsSync(deps.requestPath)).toBe(false);
	});

	test("egress.env not owned by root is refused", async () => {
		// The test runs as an ordinary user, so the real ownership check fails.
		writeRequest(policy());
		expect(await runHelper({ ...deps, allowAnyOwner: false })).toBe(1);
		expect(calls).toEqual([]);
		expect(status().error).toMatch(/owned by root/);
	});

	test("a symbolic link as egress.env is refused", async () => {
		symlinkSync(deps.envPath, join(dir, "link.env"));
		expect(await runHelper({ ...deps, envPath: join(dir, "link.env") })).toBe(1);
		expect(status().error).toMatch(/not a regular file/);
	});
});

describe("at boot, when the table is missing", () => {
	async function applyOnce(p: EgressApplyPolicy): Promise<void> {
		writeRequest(p);
		await runHelper(deps);
		calls = [];
		seenAtCall = [];
		tableLoadedNow = false;
	}

	test("the last applied allow-list is loaded and our dnsmasq is queued, not waited for", async () => {
		await applyOnce(policy());
		expect(await runHelper(deps)).toBe(0);
		expect(loads()).toHaveLength(1);
		expect(loads()[0]).toMatch(
			/add rule inet portikus_egress forward iifname "portikus-ws" drop/,
		);
		expect(loads()[0]).toMatch(/redirect to :5300/);
		expect(systemctls()).toEqual(["restart --no-block portikus-egress-dns.service"]);
	});

	test("a failed allow-list load falls back to dropping all forwarded traffic", async () => {
		await applyOnce(policy());
		let n = 0;
		deps.run = async (file, args, input) => {
			calls.push({ file, args, input });
			if (args[0] === "list") return { code: 1, stderr: "" };
			n += 1;
			return n === 1
				? { code: 1, stderr: "Error: no such device" }
				: { code: 0, stderr: "" };
		};
		expect(await runHelper(deps)).toBe(1);
		const [first, second] = loads();
		expect(first).toMatch(/redirect to :5300/);
		expect(second?.split("\n").filter((l) => l.startsWith("add rule"))).toEqual([
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
		expect(status().error).toMatch(/workspace forwarding is dropped/);
	});

	test("an unreadable applied.json falls back to drop-all", async () => {
		await applyOnce(policy());
		writeFileSync(state("applied.json"), "{broken");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toHaveLength(1);
		expect(
			loads()[0]
				?.split("\n")
				.filter((l) => l.startsWith("add rule")),
		).toEqual(['add rule inet portikus_egress forward iifname "portikus-ws" drop']);
	});

	test("the last applied open mode loads empty chains and starts no dnsmasq", async () => {
		await applyOnce(policy({ mode: "open" }));
		expect(await runHelper(deps)).toBe(0);
		expect(loads()[0]).not.toMatch(/add rule/);
		expect(systemctls()).toEqual([]);
	});

	test("a failed load after open mode with blocked sites also drops, failing closed", async () => {
		await applyOnce(policy({ mode: "open", names: [], blocked: ["games.com"] }));
		deps.run = async (file, args, input) => {
			calls.push({ file, args, input });
			if (args[0] === "list") return { code: 1, stderr: "" };
			const first = loads().length === 1;
			return first ? { code: 1, stderr: "Error" } : { code: 0, stderr: "" };
		};
		expect(await runHelper(deps)).toBe(1);
		expect(loads()[1]).toMatch(/forward iifname "portikus-ws" drop/);
	});

	test("an applied.json from before blocked sites still loads as open mode", async () => {
		await applyOnce(policy({ mode: "open", names: [] }));
		const old = JSON.parse(read("applied.json") ?? "");
		delete old.policy.blocked;
		writeFileSync(state("applied.json"), JSON.stringify(old));
		expect(await runHelper(deps)).toBe(0);
		expect(loads()[0]).not.toMatch(/add rule/);
		expect(read("blocked.txt")).toBe("");
	});

	test("a site that never applied stays open and loads nothing", async () => {
		tableLoadedNow = false;
		expect(await runHelper(deps)).toBe(0);
		expect(loads()).toEqual([]);
	});

	test("an unusable egress.env after an allow-list drops forwarding on the recorded bridge", async () => {
		await applyOnce(policy());
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toHaveLength(1);
		expect(
			loads()[0]
				?.split("\n")
				.filter((l) => l.startsWith("add rule")),
		).toEqual(['add rule inet portikus_egress forward iifname "portikus-ws" drop']);
		expect(status().error).toMatch(/workspace forwarding is dropped/);
	});

	test("an unusable egress.env after open mode loads nothing", async () => {
		await applyOnce(policy({ mode: "open" }));
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toEqual([]);
	});

	test("an unusable egress.env on a site that never applied loads nothing", async () => {
		tableLoadedNow = false;
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toEqual([]);
	});

	test("an unusable egress.env with the table still loaded changes nothing", async () => {
		await applyOnce(policy());
		tableLoadedNow = true;
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toEqual([]);
	});

	const droppedRules = () =>
		loads()[0]
			?.split("\n")
			.filter((l) => l.startsWith("add rule"));

	test("a recorded bridge that fails the bridge pattern is not used; the default bridge is dropped", async () => {
		await applyOnce(policy());
		const applied = JSON.parse(read("applied.json") ?? "");
		writeFileSync(
			state("applied.json"),
			JSON.stringify({ ...applied, bridge: 'ws" accept' }),
		);
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(loads()).toHaveLength(1);
		expect(droppedRules()).toEqual([
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
	});

	test("an unusable egress.env after an allow-list with no recorded bridge drops the default bridge", async () => {
		await applyOnce(policy());
		const { bridge: _b, ...applied } = JSON.parse(read("applied.json") ?? "");
		writeFileSync(state("applied.json"), JSON.stringify(applied));
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(droppedRules()).toEqual([
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
		expect(status().error).toMatch(/workspace forwarding is dropped/);
	});

	test("an unusable egress.env with a corrupt applied.json fails closed on the default bridge", async () => {
		await applyOnce(policy({ mode: "open" }));
		writeFileSync(state("applied.json"), "{not json");
		writeFileSync(deps.envPath, "garbage\n");
		expect(await runHelper(deps)).toBe(1);
		expect(droppedRules()).toEqual([
			'add rule inet portikus_egress forward iifname "portikus-ws" drop',
		]);
		expect(status().error).toMatch(/workspace forwarding is dropped/);
	});

	test("a pending request is applied after the restore", async () => {
		await applyOnce(policy());
		writeRequest(policy({ version: 4, mode: "open" }), "boot-req");
		expect(await runHelper(deps)).toBe(0);
		expect(loads()).toHaveLength(2);
		expect(status()).toMatchObject({ requestId: "boot-req", ok: true });
	});
});

describe("the command runner", () => {
	// At boot `nft list table` exits at once when the table is missing; a
	// write to its closed input must not crash the helper and leave
	// workspaces open.
	test("survives a command that exits before reading its input", async () => {
		const r = await defaultRunner()("/bin/false", [], "x".repeat(1 << 20));
		expect(r.code).not.toBe(0);
	});
});
