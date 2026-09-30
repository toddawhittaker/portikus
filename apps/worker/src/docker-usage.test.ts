import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentDockerInventory } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { fetchDockerInventory } from "./agent-client.js";
import {
	createInventoryPoll,
	inventoryImageName,
	presenceRows,
	pruneDockerUsage,
} from "./docker-usage.js";

const id = (c: string) => `sha256:${c.repeat(64)}`;
const layer = (c: string) => `sha256:${c.repeat(64)}`;

const PYTHON = {
	id: id("1"),
	repoTags: ["python:3.12"],
	layers: [layer("a"), layer("b")],
};
const NODE = { id: id("2"), repoTags: ["node:22"], layers: [layer("c")] };
const POSTGRES = { id: id("3"), repoTags: ["postgres:16"], layers: [layer("d")] };
const SEED = new Set([
	"docker.io/library/python:3.12",
	"docker.io/library/node:22",
	"docker.io/library/postgres:16",
]);

function inventory(over: Partial<AgentDockerInventory> = {}): AgentDockerInventory {
	return {
		available: true,
		images: [PYTHON, NODE, POSTGRES],
		containerImageIds: [],
		...over,
	};
}

describe("inventoryImageName", () => {
	test("canonical for Docker Hub and ghcr.io, as given for other registries", () => {
		expect(inventoryImageName("redis")).toBe("docker.io/library/redis:latest");
		expect(inventoryImageName("ghcr.io/o/t:1")).toBe("ghcr.io/o/t:1");
		expect(inventoryImageName("quay.io/x/y")).toBe("quay.io/x/y:latest");
		expect(inventoryImageName("localhost:5000/app:dev")).toBe("localhost:5000/app:dev");
		expect(inventoryImageName("<none>:<none>")).toBeNull();
	});
});

describe("presenceRows: the seed-use rule (ruling 7)", () => {
	test("no container and no derived image: every seed image is unused", () => {
		const rows = presenceRows(inventory(), SEED);
		expect(rows.every((r) => r.inSeed && !r.used)).toBe(true);
	});

	test("a container referencing a seed image marks it used", () => {
		const rows = presenceRows(inventory({ containerImageIds: [NODE.id] }), SEED);
		expect(rows.find((r) => r.image === "docker.io/library/node:22")?.used).toBe(true);
		expect(rows.find((r) => r.image === "docker.io/library/python:3.12")?.used).toBe(
			false,
		);
	});

	test("an image whose layers start with a seed image's layers marks it used", () => {
		const app = {
			id: id("9"),
			repoTags: ["myapp:dev"],
			layers: [layer("a"), layer("b"), layer("e")],
		};
		const rows = presenceRows(
			inventory({ images: [PYTHON, NODE, POSTGRES, app] }),
			SEED,
		);
		expect(rows.find((r) => r.image === "docker.io/library/python:3.12")?.used).toBe(
			true,
		);
		// Only a prefix counts: sharing a middle layer does not.
		const other = { id: id("8"), repoTags: ["x:1"], layers: [layer("f"), layer("c")] };
		const rows2 = presenceRows(inventory({ images: [NODE, other] }), SEED);
		expect(rows2.find((r) => r.image === "docker.io/library/node:22")?.used).toBe(
			false,
		);
	});

	test("a seed image built on another seed image does not mark it used", () => {
		const debian = { id: id("7"), repoTags: ["debian:bookworm"], layers: [layer("a")] };
		const seed = new Set([...SEED, "docker.io/library/debian:bookworm"]);
		const rows = presenceRows(inventory({ images: [debian, PYTHON] }), seed);
		expect(
			rows.find((r) => r.image === "docker.io/library/debian:bookworm")?.used,
		).toBe(false);
	});

	test("images not in the seed are listed with inSeed false", () => {
		const redis = { id: id("6"), repoTags: ["redis:7", "redis:latest"], layers: [] };
		const rows = presenceRows(
			inventory({ images: [redis], containerImageIds: [redis.id] }),
			SEED,
		);
		expect(rows).toEqual([
			{ image: "docker.io/library/redis:7", inSeed: false, used: true },
			{ image: "docker.io/library/redis:latest", inSeed: false, used: true },
		]);
	});
});

describe("fetchDockerInventory", () => {
	async function agentAnswering(body: string, status = 200) {
		const server = createServer((req, res) => {
			res.writeHead(req.headers.authorization === "Bearer tok" ? status : 401, {
				"content-type": "application/json",
			});
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { server, port: (server.address() as AddressInfo).port };
	}

	test("a reply that fails the schema is no data", async () => {
		const bad = {
			...inventory(),
			images: [{ id: "not-an-id", repoTags: [], layers: [] }],
		};
		const { server, port } = await agentAnswering(JSON.stringify(bad));
		try {
			expect(await fetchDockerInventory("127.0.0.1", port, "tok")).toBeNull();
		} finally {
			server.close();
		}
	});

	test("a valid reply is returned; an error status is no data", async () => {
		const { server, port } = await agentAnswering(JSON.stringify(inventory()));
		try {
			expect(await fetchDockerInventory("127.0.0.1", port, "tok")).toEqual(inventory());
			expect(await fetchDockerInventory("127.0.0.1", port, "wrong")).toBeNull();
		} finally {
			server.close();
		}
	});
});

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

describe.skipIf(skip)("inventory poll and retention", () => {
	beforeAll(async () => {
		tdb = await createTestDb();
	});
	afterAll(async () => {
		await tdb.close();
	});
	beforeEach(async () => {
		await tdb.truncate();
		await tdb.db
			.insertInto("docker_seed")
			.values({
				images: JSON.stringify(["python:3.12", "node:22", "postgres:16"]),
				size_bytes: 1,
				image_version: "2026.09.15",
				built_at: "2026-09-30T00:00:00.000Z",
			})
			.execute();
	});

	async function workspace(address: string): Promise<string> {
		counter++;
		const row = await tdb.db
			.insertInto("workspaces")
			.values({
				label: `ws-inv-${counter}`,
				owner_user_id: await insertTestUser(tdb.db),
				state: "running",
				agent_address: address,
				agent_token: `token-${counter}`,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function presence(ws: string) {
		return tdb.db
			.selectFrom("docker_image_presence")
			.select(["image", "in_seed", "used"])
			.where("workspace_id", "=", ws)
			.orderBy("image")
			.execute();
	}

	test("replaces each workspace's rows; no data keeps the earlier rows", async () => {
		const a = await workspace("10.200.0.10");
		const b = await workspace("10.200.0.11");
		const answers = new Map<string, AgentDockerInventory | null>([
			["10.200.0.10", inventory({ containerImageIds: [NODE.id] })],
			[
				"10.200.0.11",
				inventory({ available: false, images: [], containerImageIds: [] }),
			],
		]);
		const { logger } = collectingLogger();
		const asked: string[] = [];
		const tick = createInventoryPoll({
			db: tdb.db,
			logger,
			readInventory: async (address) => {
				asked.push(address);
				return answers.get(address) ?? null;
			},
		});
		await tick();
		// Only workspace rows are read: never the seed builder or any other instance.
		expect(asked.sort()).toEqual(["10.200.0.10", "10.200.0.11"]);
		expect(await presence(a)).toEqual([
			{ image: "docker.io/library/node:22", in_seed: true, used: true },
			{ image: "docker.io/library/postgres:16", in_seed: true, used: false },
			{ image: "docker.io/library/python:3.12", in_seed: true, used: false },
		]);
		expect(await presence(b)).toEqual([]);

		answers.set("10.200.0.10", null);
		await tick();
		expect(await presence(a)).toHaveLength(3);

		answers.set("10.200.0.10", inventory({ images: [NODE] }));
		await tick();
		expect(await presence(a)).toEqual([
			{ image: "docker.io/library/node:22", in_seed: true, used: false },
		]);
	});

	test("retention deletes usage rows and finished jobs older than 90 days", async () => {
		const ws = await workspace("10.200.0.12");
		const now = new Date("2026-09-30T00:00:00Z");
		const old = new Date(now.getTime() - 91 * 86_400_000).toISOString();
		const recent = new Date(now.getTime() - 89 * 86_400_000).toISOString();
		await tdb.db
			.insertInto("docker_image_pulls")
			.values([
				{ image: "old", workspace_id: ws, pulls: 1, last_seen: old },
				{ image: "recent", workspace_id: ws, pulls: 1, last_seen: recent },
			])
			.execute();
		await tdb.db
			.insertInto("docker_image_presence")
			.values([
				{
					workspace_id: ws,
					image: "old",
					in_seed: false,
					used: false,
					sampled_at: old,
				},
				{
					workspace_id: ws,
					image: "recent",
					in_seed: false,
					used: false,
					sampled_at: recent,
				},
			])
			.execute();
		await tdb.db
			.insertInto("docker_seed_jobs")
			.values([
				{ images: "[]", state: "failed", finished_at: old },
				{ images: "[]", state: "failed", finished_at: recent },
			])
			.execute();
		await pruneDockerUsage(tdb.db, now);
		const images = async (table: "docker_image_pulls" | "docker_image_presence") =>
			(await tdb.db.selectFrom(table).select("image").execute()).map((r) => r.image);
		expect(await images("docker_image_pulls")).toEqual(["recent"]);
		expect(await images("docker_image_presence")).toEqual(["recent"]);
		expect(
			await tdb.db.selectFrom("docker_seed_jobs").select("id").execute(),
		).toHaveLength(1);
	});
});
