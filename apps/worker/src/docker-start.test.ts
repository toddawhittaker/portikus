import type { EgressPolicy } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dockerConfigFor, dockerStartConfig } from "./docker-start.js";

const OPEN: EgressPolicy = {
	mode: "open",
	presets: [],
	ports: [],
	entries: [],
	blockedSites: [],
};

function allowList(hosts: string[]): EgressPolicy {
	return {
		...OPEN,
		mode: "allow-list",
		entries: hosts.map((value) => ({ kind: "host", value, label: "" })),
	};
}

describe("dockerConfigFor (rulings 8 and S2)", () => {
	test("open mode: the Hub mirror always, ghcr only with its switch", () => {
		expect(dockerConfigFor(OPEN, false)).toEqual({ hubMirror: true, ghcr: false });
		expect(dockerConfigFor(OPEN, true)).toEqual({ hubMirror: true, ghcr: true });
	});

	test("open mode with a blocked site covering a cache name leaves that cache out", () => {
		const blockHub = { ...OPEN, blockedSites: [{ value: "docker.io", label: "" }] };
		expect(dockerConfigFor(blockHub, true)).toEqual({ hubMirror: false, ghcr: true });
		const blockGhcr = {
			...OPEN,
			blockedSites: [{ value: "githubusercontent.com", label: "" }],
		};
		expect(dockerConfigFor(blockGhcr, true)).toEqual({ hubMirror: true, ghcr: false });
	});

	test("allow-list mode: each cache only when every one of its names is listed", () => {
		expect(dockerConfigFor(allowList([]), true)).toEqual({
			hubMirror: false,
			ghcr: false,
		});
		expect(dockerConfigFor(allowList(["registry-1.docker.io"]), true).hubMirror).toBe(
			false,
		);
		expect(dockerConfigFor(allowList(["docker.io", "docker.com"]), false)).toEqual({
			hubMirror: true,
			ghcr: false,
		});
		const both = allowList([
			"docker.io",
			"docker.com",
			"ghcr.io",
			"githubusercontent.com",
		]);
		expect(dockerConfigFor(both, true)).toEqual({ hubMirror: true, ghcr: true });
		expect(dockerConfigFor(both, false)).toEqual({ hubMirror: true, ghcr: false });
	});
});

const skip = !hasTestDb();
let tdb: TestDb;

describe.skipIf(skip)("dockerStartConfig", () => {
	beforeAll(async () => {
		tdb = await createTestDb();
	});
	afterAll(async () => {
		await tdb.close();
	});
	beforeEach(async () => {
		await tdb.truncate();
	});

	test("reads the saved mode, entries and ghcr switch", async () => {
		expect(await dockerStartConfig(tdb.db)).toEqual({ hubMirror: true, ghcr: false });
		await tdb.db
			.insertInto("settings")
			.values({
				id: 1,
				shutdown_grace_seconds: 600,
				egress_mode: "allow-list",
				docker_ghcr_enabled: true,
			})
			.execute();
		expect(await dockerStartConfig(tdb.db)).toEqual({ hubMirror: false, ghcr: false });
		await tdb.db
			.insertInto("egress_entries")
			.values([
				{ kind: "host", value: "docker.io", label: "" },
				{ kind: "host", value: "docker.com", label: "" },
			])
			.execute();
		expect(await dockerStartConfig(tdb.db)).toEqual({ hubMirror: true, ghcr: false });
	});
});
