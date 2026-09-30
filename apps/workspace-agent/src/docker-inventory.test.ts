/**
 * The Docker inventory (SPEC.md §16.5, ruling S7) against a fake docker
 * runner, and the route through the server so its token check applies.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentDockerInventory,
	INVENTORY_IMAGES_MAX,
	INVENTORY_LAYERS_MAX,
	INVENTORY_OUTPUT_MAX_BYTES,
	INVENTORY_TAGS_MAX,
} from "@portikus/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFile: execFileMock,
}));

import {
	type DockerRunner,
	dockerInventory,
	INVENTORY_TIMEOUT_MS,
	resolveImageId,
	runDocker,
} from "./docker-inventory.js";
import { buildServer } from "./server.js";

const id = (n: number): string => `sha256:${n.toString(16).padStart(8, "0").repeat(8)}`;
const layer = (n: number): string =>
	`sha256:${(n + 0x1000).toString(16).padStart(64, "a")}`;

function lines(rows: object[]): string {
	return rows.map((row) => JSON.stringify(row)).join("\n");
}

interface Fake {
	images?: object[];
	containers?: object[];
	inspect?: object[];
	fail?: string;
}

function fakeRunner(fake: Fake): DockerRunner & { calls: string[][] } {
	const calls: string[][] = [];
	const run = async (args: string[]): Promise<string> => {
		calls.push(args);
		if (fake.fail && args.join(" ").startsWith(fake.fail))
			throw new Error("docker failed");
		if (args[0] === "image" && args[1] === "ls") return lines(fake.images ?? []);
		if (args[0] === "ps") return lines(fake.containers ?? []);
		if (args[0] === "image" && args[1] === "inspect")
			return JSON.stringify(fake.inspect ?? []);
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	return Object.assign(run, { calls });
}

const unavailable = { available: false, images: [], containerImageIds: [] };

describe("dockerInventory", () => {
	test("groups tags per image, reads layers and resolves container images", async () => {
		const run = fakeRunner({
			images: [
				{ ID: id(1), Repository: "redis", Tag: "7" },
				{ ID: id(1), Repository: "redis", Tag: "latest" },
				{ ID: id(2), Repository: "<none>", Tag: "<none>" },
				{ ID: id(3), Repository: "ghcr.io/org/app", Tag: "v1" },
			],
			containers: [
				{ Image: "redis" },
				{ Image: id(2).slice(7, 19) },
				{ Image: "ghcr.io/org/app:v1" },
				{ Image: "gone:1" },
			],
			inspect: [
				{
					Id: id(1),
					RepoDigests: [`redis@sha256:${"e".repeat(64)}`, 7, "no-digest"],
					RootFS: { Layers: [layer(1), layer(2)] },
				},
				{ Id: id(2), RootFS: { Layers: [layer(1)] } },
				{ Id: id(3), RootFS: {} },
			],
		});
		const result = await dockerInventory(run);
		expect(AgentDockerInventory.safeParse(result).success).toBe(true);
		expect(result).toEqual({
			available: true,
			images: [
				{
					id: id(1),
					repoTags: ["redis:7", "redis:latest"],
					repoDigests: [`redis@sha256:${"e".repeat(64)}`],
					layers: [layer(1), layer(2)],
				},
				{ id: id(2), repoTags: [], repoDigests: [], layers: [layer(1)] },
				{ id: id(3), repoTags: ["ghcr.io/org/app:v1"], repoDigests: [], layers: [] },
			],
			containerImageIds: [id(1), id(2), id(3)],
		});
		expect(run.calls[0]).toEqual(["image", "ls", "--no-trunc", "--format", "json"]);
		expect(run.calls[1]).toEqual(["ps", "-a", "--no-trunc", "--format", "json"]);
		expect(run.calls[2]).toEqual(["image", "inspect", id(1), id(2), id(3)]);
	});

	test("skips inspect when there are no images", async () => {
		const run = fakeRunner({});
		expect(await dockerInventory(run)).toEqual({
			available: true,
			images: [],
			containerImageIds: [],
		});
		expect(run.calls).toHaveLength(2);
	});

	test("truncates images, tags and layers to the caps", async () => {
		const images: object[] = [];
		for (let n = 0; n < INVENTORY_IMAGES_MAX + 5; n++) {
			images.push({ ID: id(n + 1), Repository: "r", Tag: `t${n}` });
		}
		for (let n = 0; n < INVENTORY_TAGS_MAX + 5; n++) {
			images.push({ ID: id(1), Repository: "many", Tag: `t${n}` });
		}
		const manyLayers = Array.from({ length: INVENTORY_LAYERS_MAX + 5 }, (_, n) =>
			layer(n),
		);
		const result = await dockerInventory(
			fakeRunner({ images, inspect: [{ Id: id(1), RootFS: { Layers: manyLayers } }] }),
		);
		expect(result.available).toBe(true);
		expect(result.images).toHaveLength(INVENTORY_IMAGES_MAX);
		expect(result.images[0]?.repoTags).toHaveLength(INVENTORY_TAGS_MAX);
		expect(result.images[0]?.layers).toEqual(manyLayers.slice(0, INVENTORY_LAYERS_MAX));
	});

	test.each(["image ls", "ps", "image inspect"])(
		"a failing `docker %s` gives no data",
		async (fail) => {
			const run = fakeRunner({
				images: [{ ID: id(1), Repository: "r", Tag: "1" }],
				fail,
			});
			expect(await dockerInventory(run)).toEqual(unavailable);
		},
	);

	test("output that is not JSON gives no data", async () => {
		const run: DockerRunner = async () => "not json";
		expect(await dockerInventory(run)).toEqual(unavailable);
	});

	test("gives up once the time budget is spent", async () => {
		let clock = 0;
		const run: DockerRunner = async (args, timeoutMs) => {
			expect(timeoutMs).toBeLessThanOrEqual(INVENTORY_TIMEOUT_MS);
			clock += INVENTORY_TIMEOUT_MS; // the first call uses the whole budget
			return args[0] === "image"
				? lines([{ ID: id(1), Repository: "r", Tag: "1" }])
				: "";
		};
		expect(await dockerInventory(run, () => clock)).toEqual(unavailable);
	});
});

describe("resolveImageId", () => {
	const images = [
		{ id: id(1), repoTags: ["redis:latest"] },
		{ id: id(2), repoTags: ["localhost:5000/app:latest"] },
	];
	test("adds :latest and drops docker.io prefixes", () => {
		expect(resolveImageId("docker.io/library/redis", images)).toBe(id(1));
		expect(resolveImageId("localhost:5000/app", images)).toBe(id(2));
		expect(resolveImageId("nothing", images)).toBeNull();
	});
});

describe("runDocker", () => {
	afterEach(() => execFileMock.mockReset());

	test("runs /usr/bin/docker as the agent's own user with the timeout and byte cap", async () => {
		execFileMock.mockImplementation((_file, _args, _options, callback) => {
			callback(null, "out");
		});
		expect(await runDocker(["ps"], 1234)).toBe("out");
		const [file, args, options] = execFileMock.mock.calls[0] ?? [];
		expect(file).toBe("/usr/bin/docker");
		expect(args).toEqual(["ps"]);
		expect(options).toMatchObject({
			timeout: 1234,
			maxBuffer: INVENTORY_OUTPUT_MAX_BYTES,
		});
		// No uid or gid: the child runs as the agent, which runs as the student.
		expect(options).not.toHaveProperty("uid");
		expect(options).not.toHaveProperty("gid");
	});

	test("rejects when docker fails, times out or passes the byte cap", async () => {
		execFileMock.mockImplementation((_file, _args, _options, callback) => {
			callback(
				Object.assign(new Error("maxBuffer"), {
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				}),
				"",
			);
		});
		await expect(runDocker(["ps"], 10)).rejects.toThrow();
	});
});

describe("GET /docker/inventory", () => {
	test("needs the token and answers the inventory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "portikus-docker-inv-"));
		const token = "d".repeat(64);
		await writeFile(join(dir, "agent.token"), token);
		const app = buildServer({
			tmuxSocketName: "portikus-test",
			tokenPath: join(dir, "agent.token"),
			homeDir: dir,
			dockerRunner: fakeRunner({ images: [{ ID: id(1), Repository: "r", Tag: "1" }] }),
		});
		await app.ready();
		try {
			const denied = await app.inject({ method: "GET", url: "/docker/inventory" });
			expect(denied.statusCode).toBe(401);
			const ok = await app.inject({
				method: "GET",
				url: "/docker/inventory",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(ok.statusCode).toBe(200);
			expect(AgentDockerInventory.parse(ok.json())).toEqual({
				available: true,
				images: [{ id: id(1), repoTags: ["r:1"], repoDigests: [], layers: [] }],
				containerImageIds: [],
			});
		} finally {
			await app.close();
		}
	});
});
