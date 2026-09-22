import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { HostSnapshot } from "@portikus/contracts";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parseIncusSize, readHostSnapshot, readLoadAverage } from "./host.js";
import { IncusClient, IncusError } from "./incus.js";
import { IncusWorkspaceProvider } from "./provider.js";

// A fake Incus on a unix socket. Routes answer with the response shapes read
// from the pilot on 2026-09-22 (Epic 11 task 2 spike).
let socketPath: string;
let server: http.Server;
let dir: string;
let requests: Array<{ method: string; url: string; body: string }>;
let routes: Record<string, { status: number; body: unknown }>;

function sync(metadata: unknown) {
	return { type: "sync", status: "Success", status_code: 200, metadata };
}

function notFound() {
	return { status: 404, body: { type: "error", error: "not found", error_code: 404 } };
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-test-"));
	socketPath = path.join(dir, "incus.sock");
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = (req.url ?? "").replace(/[?&]project=portikus$/, "");
			requests.push({
				method: req.method ?? "",
				url,
				body: Buffer.concat(chunks).toString(),
			});
			const route = routes[`${req.method} ${url}`] ?? notFound();
			res.writeHead(route.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(route.body));
		});
	});
	await new Promise<void>((r) => server.listen(socketPath, r));
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	fs.rmSync(dir, { recursive: true, force: true });
});

const FP = "28098c463c9e0bbadc6d1c27c34854426e2d4312bf884016c079b6590b265501";
const OLD_FP = "1111111111111111111111111111111111111111111111111111111111111111";

beforeEach(() => {
	requests = [];
	routes = {
		"GET /1.0/resources": {
			status: 200,
			body: sync({
				cpu: { total: 4 },
				memory: { used: 1954467840, total: 8589934592 },
			}),
		},
		"GET /1.0/storage-pools/workspace-data/resources": {
			status: 200,
			body: sync({
				inodes: { total: 0, used: 0 },
				space: { total: 96439631872, used: 9055681432 },
			}),
		},
		"GET /1.0/profiles/workspace": {
			status: 200,
			body: sync({
				name: "workspace",
				config: {
					"limits.cpu": "2",
					"limits.memory": "4GB",
					"limits.processes": "2000",
					"security.nesting": "true",
				},
			}),
		},
		"GET /1.0/images/aliases/portikus": {
			status: 200,
			body: sync({ name: "portikus", target: FP, type: "container" }),
		},
		[`GET /1.0/images/${FP}`]: {
			status: 200,
			body: sync({
				fingerprint: FP,
				properties: { serial: "2026.09.9", os: "debian" },
			}),
		},
		"GET /1.0/instances?recursion=1": {
			status: 200,
			body: sync([
				{
					name: "ws-aaaaaaaaaaaa",
					status: "Running",
					config: { "image.serial": "2026.09.9", "volatile.base_image": FP },
				},
				{
					name: "ws-bbbbbbbbbbbb",
					status: "Stopped",
					config: { "volatile.base_image": OLD_FP },
				},
			]),
		},
	};
});

function client(): IncusClient {
	return new IncusClient({ socketPath, project: "portikus" });
}

function provider(): IncusWorkspaceProvider {
	return new IncusWorkspaceProvider({
		client: client(),
		pool: "workspace-data",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort: 7070,
	});
}

const load = async () => [0.24, 0.09, 0.02] as [number, number, number];

test("the snapshot reads the host, pool, profile, image and instances", async () => {
	const snap = await readHostSnapshot(client(), {
		pool: "workspace-data",
		profile: "workspace",
		imageAlias: "portikus",
		loadAverage: load,
		now: () => new Date("2026-09-22T12:00:00Z"),
	});

	expect(HostSnapshot.parse(snap)).toEqual(snap);
	expect(snap).toEqual({
		observedAt: "2026-09-22T12:00:00.000Z",
		loadAverage: [0.24, 0.09, 0.02],
		cpuCount: 4,
		memory: { usedBytes: 1954467840, totalBytes: 8589934592 },
		pool: { name: "workspace-data", usedBytes: 9055681432, totalBytes: 96439631872 },
		profileLimits: { cpu: "2", memory: "4GB", processes: "2000" },
		image: { fingerprint: FP, serial: "2026.09.9" },
		instances: [
			{ name: "ws-aaaaaaaaaaaa", imageFingerprint: FP, imageSerial: "2026.09.9" },
			// An instance from an older image without a serial keeps its fingerprint.
			{ name: "ws-bbbbbbbbbbbb", imageFingerprint: OLD_FP, imageSerial: null },
		],
	});
	expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test("a missing image alias gives null image facts, not an error", async () => {
	delete routes["GET /1.0/images/aliases/portikus"];
	const snap = await provider().hostSnapshot();
	expect(snap.image).toEqual({ fingerprint: null, serial: null });
	expect(snap.profileLimits.cpu).toBe("2");
});

test("an image without a serial property gives a null serial", async () => {
	routes[`GET /1.0/images/${FP}`] = { status: 200, body: sync({ properties: {} }) };
	const snap = await provider().hostSnapshot();
	expect(snap.image).toEqual({ fingerprint: FP, serial: null });
});

test("missing profile limits and resource figures fall back safely", async () => {
	routes["GET /1.0/profiles/workspace"] = { status: 200, body: sync({ config: {} }) };
	routes["GET /1.0/resources"] = { status: 200, body: sync({}) };
	const snap = await provider().hostSnapshot();
	expect(snap.profileLimits).toEqual({ cpu: null, memory: null, processes: null });
	expect(snap.cpuCount).toBe(1);
	expect(snap.memory).toEqual({ usedBytes: 0, totalBytes: 0 });
});

test("an Incus failure other than a missing alias fails the snapshot", async () => {
	routes["GET /1.0/images/aliases/portikus"] = {
		status: 500,
		body: { type: "error", error: "boom", error_code: 500 },
	};
	await expect(provider().hostSnapshot()).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
});

test("the load average comes from a loadavg file", async () => {
	const file = path.join(dir, "loadavg");
	fs.writeFileSync(file, "0.24 0.09 0.02 1/429 1088749\n");
	expect(await readLoadAverage(file)).toEqual([0.24, 0.09, 0.02]);
	fs.writeFileSync(file, "garbage\n");
	await expect(readLoadAverage(file)).rejects.toBeInstanceOf(IncusError);
});

test("Incus size strings parse to bytes", () => {
	expect(parseIncusSize("25GiB")).toBe(25 * 2 ** 30);
	expect(parseIncusSize("4GB")).toBe(4e9);
	expect(parseIncusSize("512MiB")).toBe(512 * 2 ** 20);
	expect(parseIncusSize("1024")).toBe(1024);
	expect(parseIncusSize("lots")).toBeNull();
	expect(parseIncusSize("5XB")).toBeNull();
	expect(parseIncusSize(undefined)).toBeNull();
});

function volumeRoutes(homeSize: string, dockerSize: string): void {
	const base = "/1.0/storage-pools/workspace-data/volumes/custom";
	routes[`GET ${base}/ws-aaaaaaaaaaaa-home`] = {
		status: 200,
		body: sync({ name: "ws-aaaaaaaaaaaa-home", config: { size: homeSize } }),
	};
	routes[`GET ${base}/ws-aaaaaaaaaaaa-docker`] = {
		status: 200,
		body: sync({ name: "ws-aaaaaaaaaaaa-docker", config: { size: dockerSize } }),
	};
	routes[`PATCH ${base}/ws-aaaaaaaaaaaa-home`] = { status: 200, body: sync({}) };
	routes[`PATCH ${base}/ws-aaaaaaaaaaaa-docker`] = { status: 200, body: sync({}) };
}

test("grow patches only the volumes whose size changes", async () => {
	volumeRoutes("25GiB", "20GiB");
	const result = await provider().growVolumes("ws-aaaaaaaaaaaa", {
		homeGiB: 30,
		dockerGiB: 20,
	});
	expect(result).toEqual({ homeGiB: 30, dockerGiB: 20 });
	const patches = requests.filter((r) => r.method === "PATCH");
	expect(patches).toEqual([
		{
			method: "PATCH",
			url: "/1.0/storage-pools/workspace-data/volumes/custom/ws-aaaaaaaaaaaa-home",
			body: JSON.stringify({ config: { size: "30GiB" } }),
		},
	]);
});

test("grow refuses a shrink before changing either volume", async () => {
	volumeRoutes("25GiB", "20GiB");
	await expect(
		provider().growVolumes("ws-aaaaaaaaaaaa", { homeGiB: 40, dockerGiB: 10 }),
	).rejects.toMatchObject({
		code: "BAD_REQUEST",
		message: "Storage can only be increased.",
	});
	expect(requests.filter((r) => r.method === "PATCH")).toEqual([]);
});

test("grow to the current sizes changes nothing", async () => {
	volumeRoutes("25GiB", "20GiB");
	await provider().growVolumes("ws-aaaaaaaaaaaa", { homeGiB: 25, dockerGiB: 20 });
	expect(requests.filter((r) => r.method === "PATCH")).toEqual([]);
});

test("grow on a missing volume answers NOT_FOUND", async () => {
	await expect(
		provider().growVolumes("ws-aaaaaaaaaaaa", { homeGiB: 30, dockerGiB: 30 }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("grow refuses an invalid instance name without calling Incus", async () => {
	await expect(
		provider().growVolumes("../etc", { homeGiB: 30, dockerGiB: 30 }),
	).rejects.toMatchObject({ code: "INVALID_NAME" });
	expect(requests).toEqual([]);
});
