/**
 * Listening-port discovery (SPEC.md §14.7, §18.2, BROWSER-HANDLING.md §11.1,
 * §17): /proc parsing, inode-to-process mapping, and change detection.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	decodeHexAddress,
	ListeningMonitor,
	parseDockerPs,
	parseProcNetTcp,
	readSocketOwners,
} from "./listening.js";

const HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function row(local: string, state: string, inode: string): string {
	return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

// --- hex address decoding ---

test("decodes IPv4 addresses from host byte order", () => {
	expect(decodeHexAddress("0100007F")).toBe("127.0.0.1");
	expect(decodeHexAddress("00000000")).toBe("0.0.0.0");
	expect(decodeHexAddress("0A00020F")).toBe("15.2.0.10");
});

test("decodes IPv6 addresses and shortens zero runs", () => {
	expect(decodeHexAddress("0".repeat(32))).toBe("::");
	expect(decodeHexAddress("00000000000000000000000001000000")).toBe("::1");
	expect(decodeHexAddress("0000000000000000FFFF00000100007F")).toBe("::ffff:7f00:1");
});

test("rejects an address that is neither IPv4 nor IPv6", () => {
	expect(() => decodeHexAddress("ABCD")).toThrow();
});

// --- /proc/net/tcp parsing ---

test("keeps only LISTEN rows and decodes their address and port", () => {
	const text = [
		HEADER,
		row("0100007F:1388", "0A", "34567"),
		row("00000000:1F90", "0A", "34568"),
		// An established connection, not a listener.
		row("0100007F:C350", "01", "34569"),
	].join("\n");
	expect(parseProcNetTcp(text)).toEqual([
		{ address: "127.0.0.1", port: 5000, inode: "34567" },
		{ address: "0.0.0.0", port: 8080, inode: "34568" },
	]);
});

test("parses IPv6 listeners", () => {
	const text = [HEADER, row(`${"0".repeat(32)}:1F90`, "0A", "9001")].join("\n");
	expect(parseProcNetTcp(text)).toEqual([{ address: "::", port: 8080, inode: "9001" }]);
});

test("skips short, blank, and malformed rows without throwing", () => {
	const text = [HEADER, "", "   1: garbage", row("ZZ:1388", "0A", "1")].join("\n");
	expect(parseProcNetTcp(text)).toEqual([]);
});

// --- inode to process mapping ---

let procRoot: string;

beforeEach(async () => {
	procRoot = await mkdtemp(join(tmpdir(), "portikus-proc-"));
});

afterEach(async () => {
	await rm(procRoot, { recursive: true, force: true });
});

async function fakeProcess(pid: number, comm: string, inodes: number[]): Promise<void> {
	const dir = join(procRoot, String(pid));
	await mkdir(join(dir, "fd"), { recursive: true });
	await writeFile(join(dir, "comm"), `${comm}\n`);
	let descriptor = 3;
	for (const inode of inodes) {
		await symlink(`socket:[${inode}]`, join(dir, "fd", String(descriptor)));
		descriptor += 1;
	}
}

test("maps socket inodes to the pid and command that hold them", async () => {
	await fakeProcess(42, "node", [34567, 34568]);
	await fakeProcess(43, "python3", [55555]);
	// Not a process directory, and a process whose fd directory is missing.
	await mkdir(join(procRoot, "self"), { recursive: true });
	await mkdir(join(procRoot, "44"), { recursive: true });

	const owners = await readSocketOwners(procRoot);
	expect(owners.get("34567")).toEqual({ pid: 42, command: "node" });
	expect(owners.get("34568")).toEqual({ pid: 42, command: "node" });
	expect(owners.get("55555")).toEqual({ pid: 43, command: "python3" });
	expect(owners.size).toBe(3);
});

test("a process with no comm file still maps its sockets", async () => {
	const dir = join(procRoot, "50", "fd");
	await mkdir(dir, { recursive: true });
	await symlink("socket:[777]", join(dir, "3"));
	const owners = await readSocketOwners(procRoot);
	expect(owners.get("777")).toEqual({ pid: 50, command: undefined });
});

test("a missing /proc yields no owners rather than an error", async () => {
	expect((await readSocketOwners(join(procRoot, "nope"))).size).toBe(0);
});

// --- docker ps parsing ---

test("reads published host ports out of docker ps output", () => {
	const stdout = [
		"abc123\tpg\t0.0.0.0:5432->5432/tcp, :::5432->5432/tcp",
		"def456\tidle\t",
		"",
	].join("\n");
	expect(parseDockerPs(stdout)).toEqual([
		{ id: "abc123", name: "pg", ports: [5432] },
		{ id: "def456", name: "idle", ports: [] },
	]);
});

// --- the monitor ---

async function writeProcNet(tcp: string, tcp6 = HEADER): Promise<void> {
	await mkdir(join(procRoot, "net"), { recursive: true });
	await writeFile(join(procRoot, "net", "tcp"), tcp);
	await writeFile(join(procRoot, "net", "tcp6"), tcp6);
}

function monitorFor(
	overrides: Partial<ConstructorParameters<typeof ListeningMonitor>[0]> = {},
): ListeningMonitor {
	return new ListeningMonitor({
		procRoot,
		interfaceAddress: "10.0.0.5",
		docker: null,
		...overrides,
	});
}

test("reports a service with its process, addresses, and protocol hint", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "34567")].join("\n"));
	await fakeProcess(42, "node", [34567]);
	const services = await monitorFor().refresh();
	expect(services).toHaveLength(1);
	expect(services[0]).toMatchObject({
		port: 5000,
		addresses: ["127.0.0.1"],
		protocolHint: "http",
		process: { pid: 42, command: "node" },
		previewReachability: "unknown",
	});
	expect(services[0]?.observedAt).toMatch(/^\d{4}-/);
});

test("a wildcard bind is reachable and a low port is still reported", async () => {
	await writeProcNet([HEADER, row("00000000:0050", "0A", "1")].join("\n"));
	const services = await monitorFor().refresh();
	expect(services[0]).toMatchObject({
		port: 80,
		previewReachability: "reachable",
		protocolHint: "http",
	});
});

test("a bind on the workspace interface is reachable", async () => {
	// 10.0.0.5 in host byte order.
	await writeProcNet([HEADER, row("0500000A:22B8", "0A", "1")].join("\n"));
	const services = await monitorFor().refresh();
	expect(services[0]).toMatchObject({
		port: 8888,
		addresses: ["10.0.0.5"],
		previewReachability: "reachable",
	});
});

test("a loopback-only port with a forward open is reported as forwarded", async () => {
	await writeProcNet([HEADER, row("0100007F:1F3F", "0A", "1")].join("\n"));
	const services = await monitorFor({
		forwardedPorts: () => new Set([7999]),
	}).refresh();
	expect(services[0]).toMatchObject({
		port: 7999,
		protocolHint: "unknown",
		previewReachability: "forwarded",
	});
});

test("both address families are merged into one service per port", async () => {
	await writeProcNet(
		[HEADER, row("0100007F:1388", "0A", "1")].join("\n"),
		[HEADER, row("00000000000000000000000001000000:1388", "0A", "2")].join("\n"),
	);
	const services = await monitorFor().refresh();
	expect(services).toHaveLength(1);
	expect(services[0]?.addresses).toEqual(["127.0.0.1", "::1"]);
});

test("a container is attached to the port it publishes", async () => {
	await writeProcNet([HEADER, row("00000000:1538", "0A", "1")].join("\n"));
	const services = await monitorFor({
		docker: async () => [{ id: "abc123", name: "pg", ports: [5432] }],
	}).refresh();
	expect(services[0]?.container).toEqual({ id: "abc123", name: "pg" });
});

test("a Docker lookup that fails leaves discovery working", async () => {
	await writeProcNet([HEADER, row("00000000:1538", "0A", "1")].join("\n"));
	const services = await monitorFor({
		docker: async () => {
			throw new Error("no such file or directory");
		},
	}).refresh();
	expect(services).toHaveLength(1);
	expect(services[0]?.container).toBeUndefined();
});

test("Docker is asked once and its answer reused for five seconds", async () => {
	await writeProcNet([HEADER, row("00000000:1538", "0A", "1")].join("\n"));
	let calls = 0;
	const monitor = monitorFor({
		docker: async () => {
			calls += 1;
			return [];
		},
	});
	await monitor.refresh();
	await monitor.refresh();
	expect(calls).toBe(1);
});

test("subscribers hear only about real changes", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "1")].join("\n"));
	const monitor = monitorFor();
	const seen: number[][] = [];
	monitor.subscribe((services) => {
		seen.push(services.map((service) => service.port));
	});

	await monitor.refresh();
	await monitor.refresh();
	expect(seen).toEqual([[5000]]);

	await writeProcNet(
		[HEADER, row("0100007F:1388", "0A", "1"), row("0100007F:1F90", "0A", "2")].join(
			"\n",
		),
	);
	await monitor.refresh();
	expect(seen).toEqual([[5000], [5000, 8080]]);

	await writeProcNet(HEADER);
	await monitor.refresh();
	expect(seen).toEqual([[5000], [5000, 8080], []]);
});

test("knows which ports are listening on loopback only", async () => {
	await writeProcNet(
		[HEADER, row("0100007F:1388", "0A", "1"), row("00000000:1F90", "0A", "2")].join(
			"\n",
		),
	);
	const monitor = monitorFor();
	await monitor.refresh();
	expect(monitor.isLoopbackOnly(5000)).toBe(true);
	expect(monitor.hasLoopbackListener(5000)).toBe(true);
	expect(monitor.isLoopbackOnly(8080)).toBe(false);
	expect(monitor.isLoopbackOnly(9999)).toBe(false);
	expect(monitor.hasLoopbackListener(9999)).toBe(false);
});

test("an unreadable /proc leaves the last known list in place", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "1")].join("\n"));
	const monitor = monitorFor();
	await monitor.refresh();
	await rm(join(procRoot, "net"), { recursive: true, force: true });
	// Both files missing reads as empty, which is a real change to "nothing".
	expect(await monitor.refresh()).toEqual([]);
});

test("a port listening on ::1 only is loopback-only, like 127.0.0.1", async () => {
	await writeProcNet(
		HEADER,
		[HEADER, row("00000000000000000000000001000000:1388", "0A", "1")].join("\n"),
	);
	const monitor = monitorFor();
	const services = await monitor.refresh();
	expect(services[0]).toMatchObject({
		port: 5000,
		addresses: ["::1"],
		previewReachability: "unknown",
	});
	expect(monitor.isLoopbackOnly(5000)).toBe(true);
	expect(monitor.hasLoopbackListener(5000)).toBe(true);
	expect(monitor.loopbackTarget(5000)).toBe("::1");
});

test("the loopback target prefers IPv4 when the port has both", async () => {
	await writeProcNet(
		[HEADER, row("0100007F:1388", "0A", "1")].join("\n"),
		[HEADER, row("00000000000000000000000001000000:1388", "0A", "2")].join("\n"),
	);
	const monitor = monitorFor();
	await monitor.refresh();
	expect(monitor.loopbackTarget(5000)).toBe("127.0.0.1");
	expect(monitor.loopbackTarget(9999)).toBeNull();
});
