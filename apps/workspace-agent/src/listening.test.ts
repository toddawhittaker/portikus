/**
 * Listening-port discovery (SPEC.md §14.7, §18.2, BROWSER-HANDLING.md §11.1,
 * §17): /proc parsing, inode-to-process mapping, and change detection.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
	type AddressInfo,
	createServer as createNetServer,
	type Server,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LISTENING_SERVICES } from "@portikus/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DockerContainer, parseDockerPs } from "./docker-listeners.js";
import { AgentFailure } from "./errors.js";
import {
	capServices,
	isSystemListener,
	ListeningMonitor,
	probeTls,
	readSocketOwners,
} from "./listening.js";
import { decodeHexAddress, parseProcNetTcp } from "./proc-net.js";

const HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function row(local: string, state: string, inode: string, uid = 1000): string {
	return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
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
		{ address: "127.0.0.1", port: 5000, inode: "34567", uid: 1000 },
		{ address: "0.0.0.0", port: 8080, inode: "34568", uid: 1000 },
	]);
});

test("parses IPv6 listeners", () => {
	const text = [HEADER, row(`${"0".repeat(32)}:1F90`, "0A", "9001")].join("\n");
	expect(parseProcNetTcp(text)).toEqual([
		{ address: "::", port: 8080, inode: "9001", uid: 1000 },
	]);
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

/** A `/proc/<pid>/stat` line; only the state and start time matter here. */
function statLine(pid: number, comm: string, startTicks: number): string {
	return `${pid} (${comm}) S ${Array(18).fill("0").join(" ")} ${startTicks}\n`;
}

async function fakeProcess(
	pid: number,
	comm: string,
	inodes: number[],
	cmdline?: string,
	uid = 1000,
): Promise<void> {
	const dir = join(procRoot, String(pid));
	await mkdir(join(dir, "fd"), { recursive: true });
	await writeFile(join(dir, "comm"), `${comm}\n`);
	await writeFile(
		join(dir, "status"),
		`Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
	);
	await writeFile(join(dir, "stat"), statLine(pid, comm, 500));
	if (cmdline !== undefined) await writeFile(join(dir, "cmdline"), cmdline);
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

	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("34567")).toEqual({ pid: 42, command: "node" });
	expect(owners.get("34568")).toEqual({ pid: 42, command: "node" });
	expect(owners.get("55555")).toEqual({ pid: 43, command: "python3" });
	expect(owners.size).toBe(3);
});

test("reads a NUL-separated command line and turns the separators into spaces", async () => {
	await fakeProcess(
		42,
		"MainThread",
		[34567],
		"python\x00server.py\x00--port\x008080\x00",
	);
	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("34567")).toEqual({
		pid: 42,
		command: "MainThread",
		commandLine: "python server.py --port 8080",
	});
});

test("an empty command line is left out", async () => {
	await fakeProcess(42, "node", [34567], "\x00");
	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("34567")).toEqual({ pid: 42, command: "node" });
});

test("another account's command line is never read (SPEC.md §24.11)", async () => {
	await fakeProcess(42, "resolved", [34567], "systemd-resolved\x00--secret\x00", 991);
	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("34567")).toEqual({ pid: 42, command: "resolved" });
});

test("a process with no status file gets no command line", async () => {
	await fakeProcess(42, "node", [34567], "node\x00server.js\x00");
	await rm(join(procRoot, "42", "status"));
	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("34567")).toEqual({ pid: 42, command: "node" });
});

test("a process with no comm file still maps its sockets", async () => {
	const dir = join(procRoot, "50", "fd");
	await mkdir(dir, { recursive: true });
	await symlink("socket:[777]", join(dir, "3"));
	const owners = await readSocketOwners(procRoot, 1000);
	expect(owners.get("777")).toEqual({ pid: 50, command: undefined });
});

test("a missing /proc yields no owners rather than an error", async () => {
	expect((await readSocketOwners(join(procRoot, "nope"), 1000)).size).toBe(0);
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
		studentUid: 1000,
		// Fixture ports must not reach whatever this host is running.
		probeTls: async () => false,
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
	expect(services[0]?.process).toEqual({ pid: 42, command: "node" });
});

test("a service carries the command line when /proc has one", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "34567")].join("\n"));
	await fakeProcess(42, "MainThread", [34567], "python\x00server.py\x00");
	const services = await monitorFor().refresh();
	expect(services[0]?.process).toEqual({
		pid: 42,
		command: "MainThread",
		commandLine: "python server.py",
	});
});

test("a system listener carries no command line, even one the student's uid runs", async () => {
	await writeProcNet([HEADER, row("0100007F:1F90", "0A", "34567")].join("\n"));
	// The agent itself runs as the student but is a system listener.
	await fakeProcess(42, "node", [34567], "node\x00agent.js\x00");
	const services = await monitorFor({ selfPid: 42 }).refresh();
	expect(services[0]?.system).toBe(true);
	expect(services[0]?.process).toEqual({ pid: 42, command: "node" });
});

test("a Docker listener carries no command line", async () => {
	await writeProcNet([HEADER, row("00000000:1538", "0A", "34567")].join("\n"));
	await fakeProcess(
		42,
		"docker-proxy",
		[34567],
		"docker-proxy\x00-host-port\x005432\x00",
	);
	const services = await monitorFor({
		docker: async () => [{ id: "abc123", name: "pg", ports: [5432] }],
	}).refresh();
	expect(services[0]?.container).toEqual({ id: "abc123", name: "pg" });
	expect(services[0]?.process).toEqual({ pid: 42, command: "docker-proxy" });
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

// --- system listeners (SPEC.md 18.2) ---

test("the uid of the socket owner is read from the row", () => {
	const text = [HEADER, row("00000000:1F90", "0A", "1", 0)].join("\n");
	expect(parseProcNetTcp(text)[0]?.uid).toBe(0);
});

test("a root-owned or system-uid listener is a system service", () => {
	expect(isSystemListener({ uids: [0], hasContainer: false, selfPid: 9 })).toBe(true);
	expect(isSystemListener({ uids: [101], hasContainer: false, selfPid: 9 })).toBe(true);
});

test("the agent's own listener is a system service whatever its uid", () => {
	// The agent runs as the student, so only the pid identifies it.
	expect(
		isSystemListener({ ownerPid: 9, uids: [1000], hasContainer: false, selfPid: 9 }),
	).toBe(true);
});

test("a student's own listener is not a system service", () => {
	expect(
		isSystemListener({ ownerPid: 42, uids: [1000], hasContainer: false, selfPid: 9 }),
	).toBe(false);
});

/**
 * A port is hidden only when nothing listening on it is the
 * student's. A dev server bound on both IPv4 and IPv6 can show one row owned
 * by a system account beside the student's own; hiding that port would hide
 * the student's work.
 */
test("a port with one student listener among system ones is the student's", () => {
	expect(
		isSystemListener({
			ownerPid: 42,
			uids: [0, 1000],
			hasContainer: false,
			selfPid: 9,
		}),
	).toBe(false);
	expect(
		isSystemListener({
			ownerPid: 42,
			uids: [1000, 101],
			hasContainer: false,
			selfPid: 9,
		}),
	).toBe(false);
	// Every row a system account's: still hidden.
	expect(
		isSystemListener({ ownerPid: 42, uids: [0, 101], hasContainer: false, selfPid: 9 }),
	).toBe(true);
	// A uid we could not read is not evidence that the port is the system's.
	expect(isSystemListener({ uids: [-1], hasContainer: false, selfPid: 9 })).toBe(false);
	expect(isSystemListener({ uids: [], hasContainer: false, selfPid: 9 })).toBe(false);
});

test("a port published by a container is the student's, not the system's", () => {
	// docker-proxy holds the socket as root, but the service is the student's.
	expect(isSystemListener({ uids: [0], hasContainer: true, selfPid: 9 })).toBe(false);
});

test("the monitor flags systemd-resolved and its own port as system", async () => {
	await writeProcNet(
		[
			HEADER,
			row("00000000:14EB", "0A", "1", 0),
			row("00000000:1CE8", "0A", "2", 1000),
			row("00000000:1435", "0A", "3", 1000),
		].join("\n"),
	);
	await fakeProcess(77, "portikus-agent", [2]);
	await fakeProcess(88, "node", [3]);
	const services = await monitorFor({ selfPid: 77 }).refresh();
	const flags = Object.fromEntries(
		services.map((service) => [service.port, service.system]),
	);
	expect(flags).toEqual({ 5355: true, 7400: true, 5173: false });
});

test("a port the agent forwards stays the student's, and the owner is theirs", async () => {
	// The student's server on loopback, plus the agent's own forward on the
	// workspace interface at the same port, plus the agent's API port alone
	// (BROWSER-HANDLING.md 11.1).
	await writeProcNet(
		[
			HEADER,
			// The agent's forward comes first, as /proc may well list it.
			row("0500000A:104D", "0A", "11", 1000),
			row("0100007F:104D", "0A", "10", 1000),
			row("00000000:1CE8", "0A", "12", 1000),
		].join("\n"),
	);
	await fakeProcess(4242, "node", [10]);
	await fakeProcess(77, "portikus-agent", [11, 12]);
	const services = await monitorFor({
		selfPid: 77,
		forwardedPorts: () => new Set([4173]),
	}).refresh();
	const forwarded = services.find((service) => service.port === 4173);
	expect(forwarded).toMatchObject({
		system: false,
		process: { pid: 4242, command: "node" },
	});
	// The agent's own API port is still hidden.
	expect(services.find((service) => service.port === 7400)?.system).toBe(true);
});

// --- stopping a listener (SPEC.md 18.2) ---

/** Drop every listening row, the way the kernel does when a process exits. */
function clearProcNet(): void {
	writeFileSync(join(procRoot, "net", "tcp"), HEADER);
	writeFileSync(join(procRoot, "net", "tcp6"), HEADER);
}

/** The error `process.kill` raises, with the errno the kernel gave. */
function killError(code: "ESRCH" | "EPERM"): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`kill ${code}`);
	error.code = code;
	return error;
}

test("stopping a student listener sends SIGTERM and stops there", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const signals: [number, string][] = [];
	let alive = true;
	const monitor = monitorFor({
		kill: (pid, signal) => {
			if (Number(signal) === 0) {
				if (!alive) throw killError("ESRCH");
				return;
			}
			signals.push([pid, String(signal)]);
			alive = false;
			// The socket goes with the process.
			clearProcNet();
		},
		graceMs: 1000,
	});
	await monitor.stopListener(5173);
	expect(signals).toEqual([[88, "SIGTERM"]]);
});

test("a process that ignores SIGTERM is killed after the grace period", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const signals: string[] = [];
	let alive = true;
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			if (Number(signal) === 0) {
				if (!alive) throw killError("ESRCH");
				return;
			}
			signals.push(String(signal));
			if (signal === "SIGKILL") {
				alive = false;
				clearProcNet();
			}
		},
		graceMs: 100,
	});
	await monitor.stopListener(5173);
	expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

/**
 * A pid can die while the port stays open, because a parent that
 * forked the server inherited the listening socket. Saying "stopped" there
 * would be a lie: the student would see the service still running.
 */
/**
 * A server often keeps the port for a moment after it accepts
 * the signal. That delay is not a failed stop.
 */
test("a port that frees shortly after the process exits is a success", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			// The process has accepted the stop. The socket stays a moment.
			if (Number(signal) === 0) throw killError("ESRCH");
			setTimeout(() => clearProcNet(), 120);
		},
		graceMs: 500,
	});
	await expect(monitor.stopListener(5173)).resolves.toBeUndefined();
});

test("a port still listening after the pid died is not a success", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	let alive = true;
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			if (Number(signal) === 0) {
				if (!alive) throw killError("ESRCH");
				return;
			}
			// The process goes; the proc table keeps the port.
			alive = false;
		},
		graceMs: 1000,
	});
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "STOP_FAILED",
	});
});

/**
 * Only ESRCH means the process is gone. EPERM means we were not
 * allowed to signal it, which is a refusal, not a stop.
 */
test("a SIGTERM refused with EPERM is a refusal, not a success", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({
		kill: () => {
			throw killError("EPERM");
		},
		graceMs: 100,
	});
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "PROCESS_PROTECTED",
	});
});

// A port stop must not reach a process no stop path may signal (SPEC.md §18.3).
test("the tmux server's listener is refused as protected", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "tmux: server", [3]);
	const monitor = monitorFor({
		protectedPids: async () => new Set([88]),
		kill: () => {
			throw new Error("a protected process must never be signalled");
		},
	});
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "PROCESS_PROTECTED",
	});
});

test("a PID reused during the grace period is never sent SIGKILL", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const signals: string[] = [];
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			if (Number(signal) === 0) return;
			signals.push(String(signal));
			// The server exits and a new process takes its PID at once.
			clearProcNet();
			writeFileSync(join(procRoot, "88", "stat"), statLine(88, "other", 900));
		},
		graceMs: 100,
	});
	await expect(monitor.stopListener(5173)).resolves.toBeUndefined();
	expect(signals).toEqual(["SIGTERM"]);
});

test("a liveness check refused with EPERM is a conflict, not a success", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			// The signal lands, but we may not ask whether it worked.
			if (Number(signal) === 0) throw killError("EPERM");
		},
		graceMs: 100,
	});
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "STOP_FAILED",
	});
});

/** A pid already gone is fine, as long as the port went with it. */
test("a pid that is already gone stops cleanly when the port is free", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({
		kill: () => {
			clearProcNet();
			throw killError("ESRCH");
		},
		graceMs: 100,
	});
	await expect(monitor.stopListener(5173)).resolves.toBeUndefined();
});

/**
 * After SIGKILL the port is the test, not the pid. A killed
 * process whose parent has not reaped it is a zombie, and a zombie still
 * answers signal 0, so asking whether the pid exists would refuse a stop
 * that worked.
 */
test("a zombie left behind by SIGKILL still counts as stopped", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({
		kill: (_pid, signal) => {
			// Nothing ever exits here: signal 0 keeps saying the pid is there.
			if (signal === "SIGKILL") clearProcNet();
		},
		graceMs: 50,
	});
	await expect(monitor.stopListener(5173)).resolves.toBeUndefined();
});

test("a process that survives SIGKILL is reported as a conflict", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "3", 1000)].join("\n"));
	await fakeProcess(88, "node", [3]);
	const monitor = monitorFor({ kill: () => {}, graceMs: 50 });
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "STOP_FAILED",
	});
});

test("a root-owned listener is refused", async () => {
	await writeProcNet([HEADER, row("00000000:14EB", "0A", "1", 0)].join("\n"));
	const monitor = monitorFor({
		kill: () => {
			throw new Error("the stop must never reach a system process");
		},
	});
	await expect(monitor.stopListener(5355)).rejects.toBeInstanceOf(AgentFailure);
	await expect(monitor.stopListener(5355)).rejects.toMatchObject({
		code: "LISTENER_IS_SYSTEM",
	});
});

test("a port nothing is listening on is not found", async () => {
	await writeProcNet(HEADER);
	await expect(monitorFor().stopListener(5173)).rejects.toMatchObject({
		code: "LISTENER_NOT_FOUND",
	});
});

test("a container row is stopped with docker stop, not a signal", async () => {
	await writeProcNet([HEADER, row("00000000:1538", "0A", "1", 0)].join("\n"));
	const stopped: string[] = [];
	const monitor = monitorFor({
		docker: async () => [{ id: "abc123", name: "pg", ports: [5432] }],
		dockerStop: async (container) => {
			stopped.push(container);
		},
		kill: () => {
			throw new Error("a container must not be signalled");
		},
	});
	await monitor.stopListener(5432);
	expect(stopped).toEqual(["abc123"]);
});

// --- scan cost (SPEC.md §18.2) ---

test("the timer does not scan while nothing watches, and resumes when something does", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "1")].join("\n"));
	let calls = 0;
	let forwarded = new Set<number>();
	const monitor = monitorFor({
		docker: async () => {
			calls += 1;
			return [];
		},
		forwardedPorts: () => forwarded,
	});
	// An in-process subscriber, like the forwards' one, does not count.
	monitor.subscribe(() => {});
	await monitor.tick();
	expect(calls).toBe(0);

	const release = monitor.watch();
	await monitor.tick();
	expect(calls).toBe(1);
	release();
	release();

	// Past the Docker cache, so each scan asks again.
	vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ["Date"] });
	try {
		await monitor.tick();
		expect(calls).toBe(1);
		forwarded = new Set([5000]);
		await monitor.tick();
		expect(calls).toBe(2);
	} finally {
		vi.useRealTimers();
	}
});

test("a tick is skipped while the previous scan is still running", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "1")].join("\n"));
	let calls = 0;
	let finish: (value: DockerContainer[]) => void = () => {};
	const monitor = monitorFor({
		docker: () => {
			calls += 1;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	monitor.watch();
	const first = monitor.tick();
	await vi.waitFor(() => expect(calls).toBe(1));
	await monitor.tick();
	expect(calls).toBe(1);
	finish([]);
	await first;
});

test("the fd walk is skipped while every listening inode's owner is known", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "700")].join("\n"));
	await fakeProcess(70, "first", [700]);
	const monitor = monitorFor();
	expect((await monitor.refresh())[0]?.process?.command).toBe("first");

	// A walk would read the new name; the cache means none happens.
	await writeFile(join(procRoot, "70", "comm"), "renamed\n");
	expect((await monitor.refresh())[0]?.process?.command).toBe("first");

	// A new inode makes the next scan walk again.
	await fakeProcess(71, "second", [701]);
	await writeProcNet(
		[HEADER, row("0100007F:1388", "0A", "700"), row("0100007F:1F90", "0A", "701")].join(
			"\n",
		),
	);
	const services = await monitor.refresh();
	expect(services.map((service) => service.process?.command)).toEqual([
		"renamed",
		"second",
	]);
});

test("the fd walk runs again when a cached owner has exited", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "800")].join("\n"));
	await fakeProcess(80, "parent", [800]);
	await fakeProcess(81, "child", [800]);
	const monitor = monitorFor();
	expect((await monitor.refresh())[0]?.process?.pid).toBe(80);

	await rm(join(procRoot, "80"), { recursive: true });
	expect((await monitor.refresh())[0]?.process?.pid).toBe(81);
});

test("callers during a scan share it rather than start another", async () => {
	await writeProcNet([HEADER, row("0100007F:1388", "0A", "1")].join("\n"));
	let calls = 0;
	let finish: (value: DockerContainer[]) => void = () => {};
	const monitor = monitorFor({
		docker: () => {
			calls += 1;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const first = monitor.refresh();
	const second = monitor.refresh();
	await vi.waitFor(() => expect(calls).toBe(1));
	finish([]);
	expect(await second).toBe(await first);
	expect(calls).toBe(1);
});

test("a stop walks the fds afresh, so a reused cached pid is never signalled", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "900", 1000)].join("\n"));
	await fakeProcess(90, "server", [900]);
	const signals: number[] = [];
	let alive = true;
	const monitor = monitorFor({
		kill: (pid, signal) => {
			if (Number(signal) === 0) {
				if (!alive) throw killError("ESRCH");
				return;
			}
			signals.push(pid);
			alive = false;
			clearProcNet();
		},
		graceMs: 500,
	});
	await monitor.refresh();
	// Pid 90 now belongs to another process and 91 holds the socket.
	await rm(join(procRoot, "90"), { recursive: true });
	await fakeProcess(90, "tmux", []);
	await fakeProcess(91, "server", [900]);
	await monitor.stopListener(5173);
	expect(signals).toEqual([91]);
});

test("a stop fails rather than act on stale data when the fresh scan fails", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "900", 1000)].join("\n"));
	await fakeProcess(90, "server", [900]);
	const signals: number[] = [];
	let broken = false;
	const monitor = monitorFor({
		forwardedPorts: () => {
			if (broken) throw new Error("scan failed");
			return new Set<number>();
		},
		kill: (pid) => {
			signals.push(pid);
		},
	});
	await monitor.refresh();
	broken = true;
	await expect(monitor.stopListener(5173)).rejects.toMatchObject({
		code: "STOP_FAILED",
	});
	expect(signals).toEqual([]);
});

// --- HTTPS detection ---

/** A throwaway self-signed certificate for a local TLS listener. */
function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), "portikus-tls-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		return {
			key: readFileSync(join(dir, "key.pem")),
			cert: readFileSync(join(dir, "cert.pem")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function listenOn(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

test("the probe finds a real TLS listener and not a plain HTTP one", async () => {
	const tlsServer = createHttpsServer(selfSignedCertificate(), (_req, res) =>
		res.end("secure"),
	);
	const plainServer = createHttpServer((_req, res) => res.end("plain"));
	try {
		const tlsPort = await listenOn(tlsServer);
		const plainPort = await listenOn(plainServer);
		expect(await probeTls("127.0.0.1", tlsPort)).toBe(true);
		expect(await probeTls("127.0.0.1", plainPort)).toBe(false);
	} finally {
		tlsServer.close();
		plainServer.close();
	}
});

test("the probe asks a plain HTTP server in HTTP and never sends it a TLS handshake", async () => {
	const firstBytes: number[] = [];
	let clientErrors = 0;
	const plainServer = createHttpServer((_req, res) => res.end("plain"));
	plainServer.on("connection", (socket) =>
		socket.once("data", (chunk: Buffer) => firstBytes.push(chunk[0] ?? -1)),
	);
	plainServer.on("clientError", (error: NodeJS.ErrnoException, socket) => {
		// A probe hanging up after the status line is a reset, not a bad request.
		if (error.code !== "ECONNRESET") clientErrors += 1;
		socket.destroy();
	});
	try {
		const port = await listenOn(plainServer);
		expect(await probeTls("127.0.0.1", port)).toBe(false);
		expect(clientErrors).toBe(0);
		expect(firstBytes).not.toContain(0x16);
		expect(firstBytes.length).toBeGreaterThan(0);
	} finally {
		plainServer.close();
	}
});

test("a 400 answer to the HTTP question falls through to the TLS handshake", async () => {
	// Go and nginx HTTPS servers answer a plain request with a 400 status line.
	let tlsAttempted = false;
	const server = createNetServer((socket) =>
		socket.once("data", (chunk: Buffer) => {
			if (chunk[0] === 0x16) {
				tlsAttempted = true;
				socket.destroy();
				return;
			}
			socket.end(
				"HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n",
			);
		}),
	);
	try {
		const port = await listenOn(server);
		expect(await probeTls("127.0.0.1", port)).toBe(false);
		expect(tlsAttempted).toBe(true);
	} finally {
		server.close();
	}
});

test("a silent listener is not HTTPS and the probe stays within its budget", async () => {
	const silent = createNetServer(() => {});
	try {
		const port = await listenOn(silent);
		const started = Date.now();
		expect(await probeTls("127.0.0.1", port, 400)).toBe(false);
		expect(Date.now() - started).toBeLessThan(800);
	} finally {
		silent.close();
	}
});

test("the probe gives up on a listener that never answers", async () => {
	const silent = createNetServer(() => {});
	try {
		const port = await listenOn(silent);
		expect(await probeTls("127.0.0.1", port, 100)).toBe(false);
	} finally {
		silent.close();
	}
});

test("the probe reads a closed port as not HTTPS", async () => {
	const server = createNetServer();
	const port = await listenOn(server);
	await new Promise((resolve) => server.close(resolve));
	expect(await probeTls("127.0.0.1", port)).toBe(false);
});

/** A listening socket's `/proc/net/tcp` local address for a loopback port. */
function loopbackHex(port: number): string {
	return `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
}

test("discovery alone sends nothing to a listener", async () => {
	let connections = 0;
	const server = createNetServer((socket) => {
		connections += 1;
		socket.destroy();
	});
	try {
		const port = await listenOn(server);
		await writeProcNet([HEADER, row(loopbackHex(port), "0A", "7101")].join("\n"));
		// The real probe, so a probe on discovery would show up as a connection.
		const monitor = monitorFor({ probeTls });
		const services = await monitor.refresh();
		await monitor.refresh();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connections).toBe(0);
		expect(services[0]).toMatchObject({ port, protocolHint: "unknown" });
		expect(services[0]?.protocolKnown).toBeUndefined();
	} finally {
		server.close();
	}
});

test("the first preview request probes a TLS listener once and caches it", async () => {
	const tlsServer = createHttpsServer(selfSignedCertificate(), (_req, res) =>
		res.end("secure"),
	);
	try {
		const port = await listenOn(tlsServer);
		await writeProcNet([HEADER, row(loopbackHex(port), "0A", "7001")].join("\n"));
		const probed: string[] = [];
		const monitor = monitorFor({
			probeTls: (host, target) => {
				probed.push(`${host}:${target}`);
				return probeTls(host, target);
			},
		});
		const heard: string[] = [];
		monitor.subscribe((services) => heard.push(services[0]?.protocolHint ?? ""));

		const first = await monitor.probeProtocol(port);
		expect(first).toMatchObject({ port, protocolHint: "https", protocolKnown: true });
		expect(probed).toEqual([`127.0.0.1:${port}`]);
		// Subscribers, and so the control plane, hear the answer.
		expect(heard.at(-1)).toBe("https");

		const second = await monitor.probeProtocol(port);
		expect(second).toMatchObject({ protocolHint: "https", protocolKnown: true });
		const scanned = await monitor.refresh();
		expect(scanned[0]).toMatchObject({ protocolHint: "https", protocolKnown: true });
		expect(probed).toHaveLength(1);
	} finally {
		tlsServer.close();
	}
});

test("requests that race probe once", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "501")].join("\n"));
	let probes = 0;
	const monitor = monitorFor({
		probeTls: async () => {
			probes += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return true;
		},
	});
	const answers = await Promise.all([
		monitor.probeProtocol(5173),
		monitor.probeProtocol(5173),
		monitor.probeProtocol(5173),
	]);
	expect(probes).toBe(1);
	expect(answers.map((one) => one?.protocolHint)).toEqual(["https", "https", "https"]);
});

test("a plain listener keeps its hint, and a restart is probed again", async () => {
	await writeProcNet([HEADER, row("00000000:1435", "0A", "501")].join("\n"));
	const probed: string[] = [];
	const monitor = monitorFor({
		probeTls: async (host, port) => {
			probed.push(`${host}:${port}`);
			return false;
		},
	});
	expect(await monitor.probeProtocol(5173)).toMatchObject({
		protocolHint: "http",
		protocolKnown: true,
	});

	// A restarted server is a new socket, so its answer is unknown again.
	await writeProcNet([HEADER, row("00000000:1435", "0A", "503")].join("\n"));
	const again = await monitor.refresh();
	expect(again[0]?.protocolKnown).toBeUndefined();
	await monitor.probeProtocol(5173);
	expect(probed).toEqual(["127.0.0.1:5173", "127.0.0.1:5173"]);
});

test("system listeners and ports below 1024 are never probed", async () => {
	await writeProcNet(
		[
			HEADER,
			row("00000000:0050", "0A", "601"),
			row("00000000:14EB", "0A", "602", 101),
		].join("\n"),
	);
	const probed: number[] = [];
	const monitor = monitorFor({
		probeTls: async (_host, port) => {
			probed.push(port);
			return true;
		},
	});
	expect(await monitor.probeProtocol(80)).toMatchObject({
		protocolHint: "http",
		protocolKnown: true,
	});
	expect(await monitor.probeProtocol(5355)).toMatchObject({ protocolKnown: true });
	expect(probed).toEqual([]);
});

test("a port nothing listens on is not probed", async () => {
	await writeProcNet(HEADER);
	const probed: number[] = [];
	const monitor = monitorFor({
		probeTls: async (_host, port) => {
			probed.push(port);
			return true;
		},
	});
	expect(await monitor.probeProtocol(5173)).toBeNull();
	expect(probed).toEqual([]);
});

// --- the cap on listed services ---

test("caps the list at the contract's maximum, student listeners first", () => {
	const make = (port: number, system: boolean) => ({
		port,
		addresses: ["0.0.0.0"],
		protocolHint: "http" as const,
		previewReachability: "reachable" as const,
		system,
		observedAt: "now",
	});
	const system = Array.from({ length: 10 }, (_, index) => make(index + 1, true));
	const student = Array.from({ length: MAX_LISTENING_SERVICES + 5 }, (_, index) =>
		make(2000 + index, false),
	);
	const kept = capServices([...system, ...student]);
	expect(kept).toHaveLength(MAX_LISTENING_SERVICES);
	expect(kept.every((service) => !service.system)).toBe(true);
	expect(kept.map((service) => service.port)).toEqual(
		student.slice(0, MAX_LISTENING_SERVICES).map((service) => service.port),
	);
	const few = [make(3, true), make(1, false)];
	expect(capServices(few)).toBe(few);
});
