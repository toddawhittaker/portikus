import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	countedBlockDevices,
	createHostRateReader,
	defaultRouteInterface,
	parseDiskStats,
} from "./host-rates.js";

const ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
incusbr0	0000640A	00000000	0001	0	0	0	00FFFFFF	0	0	0
enp1s0	00000000	0102A8C0	0003	0	0	100	00000000	0	0	0
enp1s0	0002A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
`;

function netDev(rx: number, tx: number): string {
	return `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
incusbr0: 555555 10 0 0 0 0 0 0 555555 10 0 0 0 0 0 0
enp1s0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0
`;
}

function stat(busy: number, idle: number): string {
	// user nice system idle iowait irq softirq steal guest guest_nice
	return `cpu  ${busy} 0 0 ${idle} 0 0 0 0 7 7
cpu0 1 0 0 1 0 0 0 0 0 0
`;
}

function diskstats(readSectors: number, writeSectors: number): string {
	const line = (name: string, r: number, w: number) =>
		`   8       0 ${name} 10 0 ${r} 0 10 0 ${w} 0 0 0 0`;
	return [
		line("vda", readSectors, writeSectors),
		line("vda1", 1_000_000, 1_000_000),
		line("loop0", 1_000_000, 1_000_000),
		line("dm-0", 1_000_000, 1_000_000),
		line("zram0", 1_000_000, 1_000_000),
		"",
	].join("\n");
}

let dir: string;

async function writeProc(opts: {
	busy: number;
	idle: number;
	rx: number;
	tx: number;
	readSectors: number;
	writeSectors: number;
}) {
	await writeFile(join(dir, "proc/stat"), stat(opts.busy, opts.idle));
	await writeFile(join(dir, "proc/net/route"), ROUTE);
	await writeFile(join(dir, "proc/net/dev"), netDev(opts.rx, opts.tx));
	await writeFile(
		join(dir, "proc/diskstats"),
		diskstats(opts.readSectors, opts.writeSectors),
	);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "host-rates-"));
	await mkdir(join(dir, "proc/net"), { recursive: true });
	for (const name of ["vda", "loop0", "dm-0", "zram0", "ram0"]) {
		await mkdir(join(dir, "sys/block", name), { recursive: true });
	}
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function reader(clock: { t: number }) {
	return createHostRateReader({
		proc: join(dir, "proc"),
		sysBlock: join(dir, "sys/block"),
		now: () => clock.t,
	});
}

const base = {
	busy: 100,
	idle: 900,
	rx: 1000,
	tx: 2000,
	readSectors: 10,
	writeSectors: 20,
};

test("the first reading is null and the second gives rates", async () => {
	const clock = { t: 0 };
	const read = reader(clock);
	await writeProc(base);
	expect(await read()).toBeNull();

	clock.t = 10_000;
	await writeProc({
		busy: 400,
		idle: 1600,
		rx: 11_000,
		tx: 7000,
		readSectors: 30,
		writeSectors: 100,
	});
	expect(await read()).toEqual({
		// 300 busy of 1000 jiffies.
		cpuPercent: 30,
		netRxBytesPerSecond: 1000,
		netTxBytesPerSecond: 500,
		// Only vda counts: 20 and 80 sectors of 512 bytes over 10 seconds.
		diskReadBytesPerSecond: 1024,
		diskWriteBytesPerSecond: 4096,
	});
});

test("a counter that went backwards gives null, then rates resume", async () => {
	const clock = { t: 0 };
	const read = reader(clock);
	await writeProc(base);
	await read();

	clock.t = 60_000;
	await writeProc({ ...base, busy: 200, idle: 1800, rx: 10 });
	expect(await read()).toBeNull();

	clock.t = 120_000;
	await writeProc({ ...base, busy: 300, idle: 2700, rx: 10 });
	expect((await read())?.cpuPercent).toBe(10);
});

test("an unreadable file gives null rather than failing", async () => {
	const read = reader({ t: 0 });
	expect(await read()).toBeNull();
});

test("the default route's interface is chosen", () => {
	expect(defaultRouteInterface(ROUTE)).toBe("enp1s0");
	expect(defaultRouteInterface(ROUTE.split("\n").slice(0, 2).join("\n"))).toBeNull();
});

test("loop, ram, zram and device-mapper devices are not counted", () => {
	expect(
		countedBlockDevices(["vda", "nvme0n1", "loop3", "ram0", "zram0", "dm-2"]),
	).toEqual(["vda", "nvme0n1"]);
});

test("partitions are not counted, only the whole devices named", () => {
	expect(parseDiskStats(diskstats(2, 4), ["vda"])).toEqual({ read: 1024, write: 2048 });
});
