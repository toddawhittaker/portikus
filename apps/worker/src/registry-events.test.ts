import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OTHER_IMAGES_LABEL,
	REGISTRY_EVENTS_PATH,
	REGISTRY_EVENTS_TOKEN_HEADER,
	REGISTRY_NAMES_PER_DAY_MAX,
	type RegistryEvent,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createRegistryEventsServer,
	pulledImage,
	recordRegistryEvents,
	startRegistryEvents,
} from "./registry-events.js";

const TOKEN = "events-token-for-tests";
const V2 = "application/vnd.docker.distribution.manifest.v2+json";
const INDEX = "application/vnd.oci.image.index.v1+json";
const DIGEST = `sha256:${"a".repeat(64)}`;

function event(over: {
	action?: string;
	repository?: string;
	tag?: string;
	digest?: string;
	mediaType?: string;
	addr?: string;
	method?: string;
}): RegistryEvent {
	return {
		id: "e1",
		timestamp: "2026-09-30T10:00:00Z",
		action: over.action ?? "pull",
		target: {
			mediaType: over.mediaType ?? V2,
			repository: over.repository ?? "library/redis",
			...(over.tag === undefined ? { tag: "7" } : over.tag ? { tag: over.tag } : {}),
			...(over.digest ? { digest: over.digest } : {}),
		},
		request: {
			addr: over.addr ?? "10.200.0.10:41234",
			...(over.method ? { method: over.method } : {}),
		},
	};
}

describe("pulledImage", () => {
	test("counts manifest pulls by tag under the canonical name", () => {
		expect(pulledImage(event({}), "docker.io")).toBe("docker.io/library/redis:7");
		expect(pulledImage(event({ repository: "owner/tool", tag: "1" }), "ghcr.io")).toBe(
			"ghcr.io/owner/tool:1",
		);
	});

	test("ignores pushes, blobs, HEAD requests and non-index digest fetches", () => {
		expect(pulledImage(event({ action: "push" }), "docker.io")).toBeNull();
		expect(
			pulledImage(
				event({ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip" }),
				"docker.io",
			),
		).toBeNull();
		expect(pulledImage(event({ method: "HEAD" }), "docker.io")).toBeNull();
		expect(pulledImage(event({ tag: "", digest: DIGEST }), "docker.io")).toBeNull();
	});

	test("keeps a digest-only index pull as repository@digest", () => {
		expect(
			pulledImage(event({ tag: "", digest: DIGEST, mediaType: INDEX }), "docker.io"),
		).toBe(`docker.io/library/redis@${DIGEST}`);
	});
});

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

describe.skipIf(skip)("registry events (ruling S7)", () => {
	beforeAll(async () => {
		tdb = await createTestDb();
	});
	afterAll(async () => {
		await tdb.close();
	});
	beforeEach(async () => {
		await tdb.truncate();
	});

	async function workspace(address: string | null, state = "running"): Promise<string> {
		counter++;
		const row = await tdb.db
			.insertInto("workspaces")
			.values({
				label: `ws-events-${counter}`,
				owner_user_id: await insertTestUser(tdb.db),
				state,
				agent_address: address,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function pulls() {
		return tdb.db
			.selectFrom("docker_image_pulls")
			.select(["image", "workspace_id", "pulls"])
			.orderBy("image")
			.execute();
	}

	test("matches the bridge address of a running workspace and rolls up", async () => {
		const ws = await workspace("10.200.0.10");
		await workspace("10.200.0.11", "stopped");
		const now = new Date("2026-09-30T10:00:00Z");
		const stored = await recordRegistryEvents(
			tdb.db,
			{
				events: [
					event({}),
					event({ addr: "10.200.0.10" }),
					event({ repository: "library/node", tag: "22" }),
					// A stopped workspace, an address outside the bridge, a forwarded list, the gateway.
					event({ addr: "10.200.0.11:5000" }),
					event({ addr: "192.168.1.5:1234" }),
					event({ addr: "10.200.0.10, 10.200.0.12" }),
					event({ addr: "10.200.0.1:1234" }),
					// The seed builder has a bridge address but no workspace row.
					event({ addr: "10.200.0.99:40000" }),
				],
			},
			"docker.io",
			now,
		);
		expect(stored).toBe(3);
		expect(await pulls()).toEqual([
			{ image: "docker.io/library/node:22", workspace_id: ws, pulls: 1 },
			{ image: "docker.io/library/redis:7", workspace_id: ws, pulls: 2 },
		]);
		await recordRegistryEvents(tdb.db, { events: [event({})] }, "docker.io", now);
		expect((await pulls()).find((p) => p.image.includes("redis"))?.pulls).toBe(3);
	});

	test("after the day's cap of distinct names, new names count as (other images)", async () => {
		const ws = await workspace("10.200.0.20");
		const today = new Date("2026-09-30T10:00:00Z");
		await tdb.db
			.insertInto("docker_image_pulls")
			.values(
				Array.from({ length: REGISTRY_NAMES_PER_DAY_MAX }, (_, i) => ({
					image: `docker.io/library/img${i}:latest`,
					workspace_id: ws,
					pulls: 1,
					first_seen: today.toISOString(),
					last_seen: today.toISOString(),
				})),
			)
			.execute();
		await recordRegistryEvents(
			tdb.db,
			{
				events: [
					event({ addr: "10.200.0.20", repository: "library/newone", tag: "1" }),
					event({ addr: "10.200.0.20", repository: "library/img5", tag: "latest" }),
				],
			},
			"docker.io",
			today,
		);
		const rows = await pulls();
		expect(rows.find((r) => r.image === OTHER_IMAGES_LABEL)?.pulls).toBe(1);
		expect(rows.some((r) => r.image.includes("newone"))).toBe(false);
		expect(rows.find((r) => r.image === "docker.io/library/img5:latest")?.pulls).toBe(
			2,
		);

		// A new day starts a new count.
		await recordRegistryEvents(
			tdb.db,
			{
				events: [
					event({ addr: "10.200.0.20", repository: "library/newone", tag: "1" }),
				],
			},
			"docker.io",
			new Date("2026-10-01T00:00:01Z"),
		);
		expect((await pulls()).some((r) => r.image === "docker.io/library/newone:1")).toBe(
			true,
		);
	});

	test("startRegistryEvents stays off without a readable token, else listens on loopback", async () => {
		const { logger } = collectingLogger();
		const dir = await mkdtemp(join(tmpdir(), "registry-token-"));
		try {
			expect(
				await startRegistryEvents({
					db: tdb.db,
					logger,
					port: 0,
					tokenFile: join(dir, "missing"),
				}),
			).toBeNull();
			await writeFile(join(dir, "token"), `${TOKEN}\n`);
			const server = await startRegistryEvents({
				db: tdb.db,
				logger,
				port: 0,
				tokenFile: join(dir, "token"),
			});
			const address = server?.address() as AddressInfo;
			expect(address.address).toBe("127.0.0.1");
			const res = await fetch(
				`http://127.0.0.1:${address.port}${REGISTRY_EVENTS_PATH}`,
				{
					method: "POST",
					headers: { [REGISTRY_EVENTS_TOKEN_HEADER]: TOKEN },
					body: JSON.stringify({ events: [] }),
				},
			);
			expect(res.status).toBe(200);
			server?.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	describe("the listener", () => {
		async function listen() {
			const { logger } = collectingLogger();
			const server = createRegistryEventsServer({
				db: tdb.db,
				logger,
				token: TOKEN,
				port: 0,
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;
			return { server, url: `http://127.0.0.1:${port}${REGISTRY_EVENTS_PATH}` };
		}

		function post(url: string, body: string, token?: string) {
			return fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/vnd.docker.distribution.events.v2+json",
					...(token === undefined ? {} : { [REGISTRY_EVENTS_TOKEN_HEADER]: token }),
				},
				body,
			});
		}

		test("401 without the token or with a wrong one, and stores nothing", async () => {
			await workspace("10.200.0.10");
			const { server, url } = await listen();
			try {
				const body = JSON.stringify({ events: [event({})] });
				expect((await post(url, body)).status).toBe(401);
				expect((await post(url, body, "wrong")).status).toBe(401);
				expect(await pulls()).toEqual([]);
			} finally {
				server.close();
			}
		});

		test("400 for a body that fails the schema, including a bad reference", async () => {
			await workspace("10.200.0.10");
			const { server, url } = await listen();
			try {
				expect((await post(url, "not json", TOKEN)).status).toBe(400);
				const bad = event({ repository: "Library/Redis" });
				expect((await post(url, JSON.stringify({ events: [bad] }), TOKEN)).status).toBe(
					400,
				);
				const tag = event({ tag: "7;rm -rf" });
				expect((await post(url, JSON.stringify({ events: [tag] }), TOKEN)).status).toBe(
					400,
				);
				expect(await pulls()).toEqual([]);
			} finally {
				server.close();
			}
		});

		test("200 with the token; the ghcr cache names its registry", async () => {
			const ws = await workspace("10.200.0.10");
			const { server, url } = await listen();
			try {
				const body = JSON.stringify({ events: [event({})] });
				expect((await post(url, body, TOKEN)).status).toBe(200);
				const ghcr = JSON.stringify({
					events: [event({ repository: "owner/tool", tag: "1" })],
				});
				expect((await post(`${url}?registry=ghcr.io`, ghcr, TOKEN)).status).toBe(200);
				expect((await post(`${url}?registry=quay.io`, ghcr, TOKEN)).status).toBe(400);
				expect(await pulls()).toEqual([
					{ image: "docker.io/library/redis:7", workspace_id: ws, pulls: 1 },
					{ image: "ghcr.io/owner/tool:1", workspace_id: ws, pulls: 1 },
				]);
			} finally {
				server.close();
			}
		});
	});
});
