import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { VolumeInUseError } from "./host.js";
import { IncusClient } from "./incus.js";
import {
	incusError,
	readBody,
	respond,
	runningWithAddress,
	sync,
} from "./incus-test-http.js";
import { IncusWorkspaceProvider } from "./provider.js";
import {
	IncusSeedBuilder,
	SEED_BUILD_VOLUME,
	SEED_BUILDER,
	SEED_INFO_KEY,
	SEED_OLD_VOLUME,
} from "./seed-builder.js";

let socketPath: string;
let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-builder-test-"));
	socketPath = path.join(dir, "test.sock");
	server = http.createServer((req, res) => handler(req, res));
	await new Promise<void>((r) => server.listen(socketPath, r));
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve())),
	);
});

let builder: IncusSeedBuilder;

beforeEach(() => {
	const client = new IncusClient({ socketPath, project: "testproj" });
	const provider = new IncusWorkspaceProvider({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort: 1,
	});
	builder = new IncusSeedBuilder({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		stopInstance: (name, timeoutSeconds) => provider.stop(name, { timeoutSeconds }),
	});
});

describe("the seed builder", () => {
	interface Builder {
		log: string[];
		bodies: Map<string, unknown[]>;
		exists: boolean;
		volumes: Set<string>;
		usedBy: string[];
		used: number;
		/** A volume whose rename Incus refuses. */
		failRename?: string;
	}

	function serveBuilder(): Builder {
		const b: Builder = {
			log: [],
			bodies: new Map(),
			exists: false,
			volumes: new Set(),
			usedBy: [],
			used: 3 * 1024 ** 3,
		};
		const vol = "/1.0/storage-pools/mypool/volumes/custom";
		handler = async (req, res) => {
			const body = await readBody(req);
			const url = new URL(req.url ?? "/", "http://incus");
			const p = url.pathname;
			const m = req.method ?? "";
			const key = `${m} ${p}${p.endsWith("/files") ? `?${url.searchParams.get("path")}` : ""}`;
			b.log.push(key);
			if (body && !p.endsWith("/files")) {
				b.bodies.set(key, [...(b.bodies.get(key) ?? []), JSON.parse(body)]);
			}
			const inst = `/1.0/instances/${SEED_BUILDER}`;
			const notFound = () => incusError(res, 404, "not found");
			if (p === "/1.0/instances" && m === "POST") {
				b.exists = true;
				respond(res, 200, sync({}));
			} else if (p === inst && m === "DELETE") {
				if (!b.exists) return notFound();
				b.exists = false;
				respond(res, 200, sync({}));
			} else if (p === `${inst}/state` && m === "PUT") {
				if (!b.exists) return notFound();
				respond(res, 200, sync({}));
			} else if (p === `${inst}/state` && m === "GET") {
				respond(res, 200, sync(runningWithAddress("10.200.0.50")));
			} else if (p === `${inst}/exec`) {
				respond(res, 200, sync({ metadata: { return: 0 } }));
			} else if (p === `${inst}/files` && (m === "GET" || m === "HEAD")) {
				if (url.searchParams.get("path") !== "/etc/docker") return notFound();
				res.writeHead(200, { "X-Incus-type": "directory" });
				res.end("");
			} else if (p === `${inst}/files`) {
				if (m === "DELETE") return notFound();
				respond(res, 200, sync({}));
			} else if (p === vol && m === "POST") {
				b.volumes.add(JSON.parse(body).name);
				respond(res, 200, sync({}));
			} else if (p.startsWith(`${vol}/`)) {
				const rest = decodeURIComponent(p.slice(vol.length + 1));
				const name = rest.replace(/\/state$/, "");
				if (!b.volumes.has(name)) return notFound();
				if (rest.endsWith("/state")) {
					respond(res, 200, sync({ usage: { used: b.used } }));
				} else if (m === "GET") {
					respond(res, 200, sync({ name, config: {}, used_by: b.usedBy }));
				} else if (m === "DELETE") {
					b.volumes.delete(name);
					respond(res, 200, sync({}));
				} else if (m === "POST") {
					if (name === b.failRename) return incusError(res, 500, "rename failed");
					b.volumes.delete(name);
					b.volumes.add(JSON.parse(body).name);
					respond(res, 200, sync({}));
				} else {
					respond(res, 200, sync({}));
				}
			} else if (p === "/1.0/images/aliases/portikus") {
				respond(res, 200, sync({ target: "fp1" }));
			} else if (p === "/1.0/images/fp1") {
				respond(res, 200, sync({ properties: { serial: "2026.09.15" } }));
			} else {
				incusError(res, 404, `unexpected ${m} ${p}`);
			}
		};
		return b;
	}

	test("the builder is an ordinary workspace container with only a fresh Docker volume", async () => {
		const b = serveBuilder();
		await builder.prepareSeedBuilder({ maxBytes: 8 * 1024 ** 3, ghcr: false });
		const [create] = (b.bodies.get("POST /1.0/instances") ?? []) as Array<
			Record<string, unknown>
		>;
		expect(create).toEqual({
			name: SEED_BUILDER,
			source: { type: "image", alias: "portikus" },
			profiles: ["workspace"],
			devices: {
				docker: {
					type: "disk",
					pool: "mypool",
					source: SEED_BUILD_VOLUME,
					path: "/var/lib/docker",
				},
			},
		});
		// Nothing loosens the profile: no privileged or nesting keys of its own.
		expect(create).not.toHaveProperty("config");
		const [volume] =
			b.bodies.get("POST /1.0/storage-pools/mypool/volumes/custom") ?? [];
		// Shifted before the builder writes, so copies show real owners, not nobody.
		expect(volume).toEqual({
			name: SEED_BUILD_VOLUME,
			config: { size: "9GiB", "security.shifted": "true" },
		});
	});

	test("the builder gets the Hub mirror before it starts, and dockerd must answer", async () => {
		const b = serveBuilder();
		await builder.prepareSeedBuilder({ maxBytes: 8 * 1024 ** 3, ghcr: false });
		const push = b.log.indexOf(
			`POST /1.0/instances/${SEED_BUILDER}/files?/etc/docker/daemon.json`,
		);
		const start = b.log.indexOf(`PUT /1.0/instances/${SEED_BUILDER}/state`, 2);
		expect(push).toBeGreaterThan(0);
		expect(push).toBeLessThan(start);
		const execs = b.bodies.get(`POST /1.0/instances/${SEED_BUILDER}/exec`) as Array<{
			command: string[];
		}>;
		expect(execs.at(-1)?.command).toEqual(["/usr/bin/docker", "info"]);
	});

	test("a builder left by an earlier build is removed first", async () => {
		const b = serveBuilder();
		b.exists = true;
		b.volumes.add(SEED_BUILD_VOLUME);
		await builder.prepareSeedBuilder({ maxBytes: 1024 ** 3, ghcr: false });
		expect(b.log.slice(0, 3)).toEqual([
			`PUT /1.0/instances/${SEED_BUILDER}/state`,
			`DELETE /1.0/instances/${SEED_BUILDER}`,
			`DELETE /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		]);
	});

	test("commands run with no shell, one argument each", async () => {
		const b = serveBuilder();
		b.exists = true;
		expect(
			await builder.execInSeedBuilder(["/usr/bin/docker", "pull", "python:3.12"], 60),
		).toBe(0);
		const [exec] = b.bodies.get(`POST /1.0/instances/${SEED_BUILDER}/exec`) as Array<{
			command: string[];
		}>;
		expect(exec?.command).toEqual(["/usr/bin/docker", "pull", "python:3.12"]);
	});

	test("finish measures the volume, then stops and deletes the builder", async () => {
		const b = serveBuilder();
		b.exists = true;
		b.volumes.add(SEED_BUILD_VOLUME);
		expect(await builder.finishSeedBuilder()).toBe(3 * 1024 ** 3);
		const measured = b.log.indexOf(
			`GET /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}/state`,
		);
		expect(measured).toBe(0);
		expect(b.exists).toBe(false);
	});

	test("install puts the old seed back when the new one cannot take its name (F5)", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		b.failRename = SEED_BUILD_VOLUME;
		await expect(
			builder.installSeed({
				images: ["node:22"],
				sizeBytes: 5,
				imageVersion: "x",
				builtAt: "2026-09-30T12:00:00.000Z",
			}),
		).rejects.toThrow();
		expect(b.volumes.has("portikus-docker-seed")).toBe(true);
		expect(b.volumes.has(SEED_OLD_VOLUME)).toBe(false);
	});

	test("install stores its info on the volume and swaps it in for the old seed", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		const info = {
			images: ["node:22"],
			sizeBytes: 5,
			imageVersion: "2026.09.15",
			builtAt: "2026-09-30T12:00:00.000Z",
		};
		await builder.installSeed(info);
		const [patch] = b.bodies.get(
			`PATCH /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		) as Array<{ config: Record<string, string> }>;
		expect(JSON.parse(patch?.config[SEED_INFO_KEY] ?? "")).toEqual(info);
		expect([...b.volumes]).toEqual(["portikus-docker-seed"]);
		const renames = b.log.filter((l) => l.startsWith("POST /1.0/storage-pools"));
		expect(renames).toEqual([
			"POST /1.0/storage-pools/mypool/volumes/custom/portikus-docker-seed",
			`POST /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		]);
		expect(b.log.at(-1)).toBe(
			`DELETE /1.0/storage-pools/mypool/volumes/custom/${SEED_OLD_VOLUME}`,
		);
	});

	test("install refuses a build volume anything still uses (S4)", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		b.usedBy = [`/1.0/instances/${SEED_BUILDER}`];
		await expect(
			builder.installSeed({
				images: ["node:22"],
				sizeBytes: 5,
				imageVersion: "x",
				builtAt: "2026-09-30T12:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(VolumeInUseError);
		expect(b.log.some((l) => l.startsWith("PATCH") || l.startsWith("POST"))).toBe(
			false,
		);
	});

	test("the image version is the default image's serial", async () => {
		serveBuilder();
		expect(await builder.seedImageVersion()).toBe("2026.09.15");
	});
});
