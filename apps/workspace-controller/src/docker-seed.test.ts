import { SeedBuildStatus } from "@portikus/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { SeedBuildBusyError, SeedBuilds } from "./docker-seed.js";
import { FakeWorkspaceProvider } from "./fake-provider.js";

const ID = "3f0e6c1a-4b1d-4c2e-9a55-0c8f5b2d1e01";
const ID2 = "3f0e6c1a-4b1d-4c2e-9a55-0c8f5b2d1e02";
const GIB = 1024 ** 3;

let host: FakeWorkspaceProvider;
let builds: SeedBuilds;

beforeEach(() => {
	host = new FakeWorkspaceProvider();
	builds = new SeedBuilds(host, undefined, () => new Date("2026-09-30T12:00:00Z"));
});

function request(
	images: string[],
	extra: Partial<{ ghcrEnabled: boolean; maxBytes: number; id: string }> = {},
) {
	return { id: ID, images, ghcrEnabled: false, maxBytes: 8 * GIB, ...extra };
}

describe("a seed build", () => {
	test("pulls each image as its own argument, cleans up and stops dockerd before measuring", async () => {
		builds.start(request(["python:3.12", "node:22"]));
		await builds.idle();
		expect(host.seedSteps).toEqual([
			"prepare ghcr=false",
			'exec ["/usr/bin/docker","pull","python:3.12"]',
			'exec ["/usr/bin/docker","pull","node:22"]',
			'exec ["/usr/bin/docker","container","prune","--force"]',
			'exec ["/usr/bin/docker","builder","prune","--all","--force"]',
			'exec ["/usr/bin/systemctl","stop","docker.socket","docker.service"]',
			"finish",
			"install",
		]);
		const status = builds.get(ID);
		expect(SeedBuildStatus.parse(status)).toEqual({
			id: ID,
			state: "succeeded",
			step: "Done",
			message: null,
			seed: {
				images: ["python:3.12", "node:22"],
				sizeBytes: GIB,
				imageVersion: "2026.09.9",
				builtAt: "2026-09-30T12:00:00.000Z",
			},
		});
		expect(host.seed).toEqual(status?.seed);
	});

	test("reports the image being pulled while it runs", async () => {
		let release = (): void => {};
		host.seedExec = (command) => {
			if (command[2] === "node:22") {
				return -2;
			}
			return 0;
		};
		host.seedPrepareGate = new Promise<void>((r) => {
			release = r;
		});
		builds.start(request(["python:3.12", "node:22"]));
		expect(builds.get(ID)?.step).toBe("Starting the builder");
		release();
		await builds.idle();
		const status = builds.get(ID);
		expect(status?.state).toBe("failed");
		expect(status?.step).toBe("Pulling node:22 (2 of 2)");
		expect(status?.message).toMatch(/docker pull node:22 exited -2/);
	});

	test("a failed pull removes the builder and keeps the old seed", async () => {
		const old = {
			images: ["alpine:3"],
			sizeBytes: 5,
			imageVersion: "2026.09.1",
			builtAt: "2026-09-01T00:00:00.000Z",
		};
		host.seed = old;
		host.seedExec = (command) => (command[1] === "pull" ? 1 : 0);
		builds.start(request(["python:3.12"]));
		await builds.idle();
		expect(builds.get(ID)?.state).toBe("failed");
		expect(host.seedSteps).toContain("discard");
		expect(host.seedSteps).not.toContain("install");
		expect(host.seed).toBe(old);
	});

	test("a failed cleanup step fails the build before any snapshot is taken", async () => {
		host.seedExec = (command) => (command[0] === "/usr/bin/systemctl" ? 1 : 0);
		builds.start(request(["python:3.12"]));
		await builds.idle();
		expect(builds.get(ID)?.state).toBe("failed");
		expect(host.seedSteps).not.toContain("finish");
		expect(host.seedSteps).not.toContain("install");
	});

	test("an oversize seed fails and the old seed stays (S8)", async () => {
		host.seedBuildBytes = 8 * GIB + 1;
		builds.start(request(["python:3.12"]));
		await builds.idle();
		const status = builds.get(ID);
		expect(status?.state).toBe("failed");
		expect(status?.message).toMatch(/over the 8\.0 GiB cap; the old seed stays/);
		expect(host.seedSteps).not.toContain("install");
		expect(host.seedSteps).toContain("discard");
		expect(host.seed).toBeNull();
	});

	test("a seed exactly at the cap is installed", async () => {
		host.seedBuildBytes = 8 * GIB;
		builds.start(request(["python:3.12"]));
		await builds.idle();
		expect(builds.get(ID)?.state).toBe("succeeded");
	});

	test("one build at a time; the same id answers the running build", async () => {
		let release = (): void => {};
		host.seedPrepareGate = new Promise<void>((r) => {
			release = r;
		});
		builds.start(request(["python:3.12"]));
		expect(() => builds.start(request(["node:22"], { id: ID2 }))).toThrow(
			SeedBuildBusyError,
		);
		expect(builds.start(request(["python:3.12"])).id).toBe(ID);
		release();
		await builds.idle();
		// Free again once it ends.
		builds.start(request(["node:22"], { id: ID2 }));
		await builds.idle();
		expect(builds.get(ID2)?.state).toBe("succeeded");
	});

	test("a ghcr.io name is refused while the ghcr.io cache is off, and allowed when on", async () => {
		expect(() => builds.start(request(["ghcr.io/owner/tool:1"]))).toThrow(
			/Turn on the ghcr.io cache/,
		);
		expect(host.seedSteps).toEqual([]);
		builds.start(request(["ghcr.io/owner/tool:1"], { ghcrEnabled: true }));
		await builds.idle();
		expect(host.seedSteps[0]).toBe("prepare ghcr=true");
		expect(builds.get(ID)?.state).toBe("succeeded");
	});

	test("an unknown build id is not found", () => {
		expect(builds.get(ID)).toBeUndefined();
	});
});
