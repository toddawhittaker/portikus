import { readdir, readFile } from "node:fs/promises";
import type { HostRates } from "@portikus/contracts";

/** The cumulative counters one reading takes; rates are deltas between two. */
export interface HostCounters {
	/** Milliseconds since the epoch when the counters were read. */
	at: number;
	cpuTotal: number;
	cpuIdle: number;
	netRx: number;
	netTx: number;
	diskReadBytes: number;
	diskWriteBytes: number;
}

/** Busy and idle jiffies from the `cpu` line of `/proc/stat`. */
export function parseCpu(stat: string): { total: number; idle: number } {
	const line = stat.split("\n").find((l) => l.startsWith("cpu "));
	if (!line) throw new Error("no cpu line in /proc/stat");
	// user nice system idle iowait irq softirq steal; guest time is already in user.
	const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
	if (fields.length < 4 || !fields.every(Number.isFinite)) {
		throw new Error("unreadable cpu line in /proc/stat");
	}
	const total = fields.reduce((sum, n) => sum + n, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { total, idle };
}

/** The interface of the default route in `/proc/net/route`, or null. */
export function defaultRouteInterface(route: string): string | null {
	for (const line of route.split("\n").slice(1)) {
		const [iface, destination, , , , , , mask] = line.trim().split(/\s+/);
		if (iface && destination === "00000000" && mask === "00000000") return iface;
	}
	return null;
}

/** Received and sent bytes of one interface in `/proc/net/dev`. */
export function parseNetDev(dev: string, iface: string): { rx: number; tx: number } {
	for (const line of dev.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0 || line.slice(0, colon).trim() !== iface) continue;
		const fields = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/)
			.map(Number);
		const rx = fields[0];
		const tx = fields[8];
		if (rx === undefined || tx === undefined || !Number.isFinite(rx + tx)) break;
		return { rx, tx };
	}
	throw new Error(`no counters for ${iface} in /proc/net/dev`);
}

/**
 * Whole block devices worth counting: loop, RAM, zram and device-mapper
 * devices are left out, so the thin pool's layers are not counted twice.
 */
export function countedBlockDevices(names: readonly string[]): string[] {
	return names.filter((name) => !/^(loop|ram|zram|dm-)/.test(name));
}

/** Bytes read and written by the named devices, from `/proc/diskstats`. */
export function parseDiskStats(
	diskstats: string,
	devices: readonly string[],
): { read: number; write: number } {
	const wanted = new Set(devices);
	let read = 0;
	let write = 0;
	for (const line of diskstats.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (!wanted.has(fields[2] ?? "")) continue;
		// Sectors read and written; the kernel counts 512-byte sectors here.
		read += Number(fields[5]) * 512;
		write += Number(fields[9]) * 512;
	}
	if (!Number.isFinite(read + write)) throw new Error("unreadable /proc/diskstats");
	return { read, write };
}

/** The rates between two readings, or null when a counter went backwards. */
export function ratesBetween(
	previous: HostCounters,
	current: HostCounters,
): HostRates | null {
	const seconds = (current.at - previous.at) / 1000;
	const cpuTotal = current.cpuTotal - previous.cpuTotal;
	const cpuIdle = current.cpuIdle - previous.cpuIdle;
	const deltas = {
		netRx: current.netRx - previous.netRx,
		netTx: current.netTx - previous.netTx,
		diskRead: current.diskReadBytes - previous.diskReadBytes,
		diskWrite: current.diskWriteBytes - previous.diskWriteBytes,
	};
	if (seconds <= 0 || cpuTotal <= 0 || cpuIdle < 0) return null;
	if (Object.values(deltas).some((n) => n < 0)) return null;
	return {
		cpuPercent: Math.min(100, (100 * (cpuTotal - cpuIdle)) / cpuTotal),
		netRxBytesPerSecond: deltas.netRx / seconds,
		netTxBytesPerSecond: deltas.netTx / seconds,
		diskReadBytesPerSecond: deltas.diskRead / seconds,
		diskWriteBytesPerSecond: deltas.diskWrite / seconds,
	};
}

/** Read every counter once from `/proc` and `/sys/block`. */
export async function readHostCounters(
	roots: { proc: string; sysBlock: string },
	now: () => number,
): Promise<HostCounters> {
	const at = now();
	const cpu = parseCpu(await readFile(`${roots.proc}/stat`, "utf8"));
	const iface = defaultRouteInterface(
		await readFile(`${roots.proc}/net/route`, "utf8"),
	);
	if (iface === null) throw new Error("no default route");
	const net = parseNetDev(await readFile(`${roots.proc}/net/dev`, "utf8"), iface);
	const devices = countedBlockDevices(await readdir(roots.sysBlock));
	const disk = parseDiskStats(
		await readFile(`${roots.proc}/diskstats`, "utf8"),
		devices,
	);
	return {
		at,
		cpuTotal: cpu.total,
		cpuIdle: cpu.idle,
		netRx: net.rx,
		netTx: net.tx,
		diskReadBytes: disk.read,
		diskWriteBytes: disk.write,
	};
}

/**
 * A reader that keeps its previous reading in memory and returns the rates
 * since then (docs/EPIC-19.md rulings 16 and 17). The first call, and any
 * call whose files cannot be read, returns null; rates are a nice-to-have
 * and never fail the host snapshot.
 */
export function createHostRateReader(
	options: { proc?: string; sysBlock?: string; now?: () => number } = {},
): () => Promise<HostRates | null> {
	const roots = {
		proc: options.proc ?? "/proc",
		sysBlock: options.sysBlock ?? "/sys/block",
	};
	const now = options.now ?? Date.now;
	let previous: HostCounters | null = null;
	return async () => {
		let current: HostCounters;
		try {
			current = await readHostCounters(roots, now);
		} catch {
			previous = null;
			return null;
		}
		const rates = previous === null ? null : ratesBetween(previous, current);
		previous = current;
		return rates;
	};
}
