/**
 * The on-demand TLS ask (SPEC.md 20.1, 24.11): only names that really serve
 * something get a certificate, so an outsider sending made-up preview names
 * cannot spend the certificate authority's weekly rate limit.
 */
import type { ApiConfig } from "@portikus/config";
import type { ListeningService } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testConfig } from "../testing/test-support.js";
import {
	askAllows,
	NEW_NAMES_PER_WORKSPACE_PER_HOUR,
	PreviewApprovals,
} from "./edge.js";

const skip = !hasTestDb();
let testDb: TestDb;
let config: ApiConfig;

/** A registry where only `listening` (workspace id and port) has a listener. */
function registry(listening: Array<[string, number]>, system: number[] = []) {
	return {
		service: (workspaceId: string, port: number) =>
			listening.some(([id, p]) => id === workspaceId && p === port)
				? ({ port, system: system.includes(port) } as ListeningService)
				: undefined,
	};
}

async function workspace(label: string, state: "running" | "stopped") {
	const row = await testDb.db
		.insertInto("workspaces")
		.values({ owner_user_id: await insertTestUser(testDb.db), state, label })
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	config = testConfig("https://issuer.invalid");
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
});

describe.skipIf(skip)("askAllows", () => {
	const preview = (label: string, port: number) =>
		`${label}-${port}.${config.PREVIEW_SUFFIX}`;

	test("allows the site name", async () => {
		const site = new URL(config.PUBLIC_URL).hostname;
		expect(
			await askAllows(testDb.db, config, registry([]), new PreviewApprovals(), site),
		).toBe(true);
	});

	test("allows a preview name only while its port is listening", async () => {
		const id = await workspace("alice", "running");
		const live = registry([[id, 3000]]);
		expect(
			await askAllows(
				testDb.db,
				config,
				live,
				new PreviewApprovals(),
				preview("alice", 3000),
			),
		).toBe(true);
		expect(
			await askAllows(
				testDb.db,
				config,
				live,
				new PreviewApprovals(),
				preview("alice", 3000).toUpperCase(),
			),
		).toBe(true);
		expect(
			await askAllows(
				testDb.db,
				config,
				live,
				new PreviewApprovals(),
				preview("alice", 3001),
			),
		).toBe(false);
		expect(
			await askAllows(
				testDb.db,
				config,
				live,
				new PreviewApprovals(),
				preview("alice", 65535),
			),
		).toBe(false);
		expect(
			await askAllows(
				testDb.db,
				config,
				registry([]),
				new PreviewApprovals(),
				preview("alice", 3000),
			),
		).toBe(false);
	});

	test("refuses a stopped workspace even if a stale listener is known", async () => {
		const id = await workspace("bob", "stopped");
		expect(
			await askAllows(
				testDb.db,
				config,
				registry([[id, 3000]]),
				new PreviewApprovals(),
				preview("bob", 3000),
			),
		).toBe(false);
	});

	test("refuses the pre-flight check names", async () => {
		await workspace("alice", "running");
		expect(
			await askAllows(
				testDb.db,
				config,
				registry([]),
				new PreviewApprovals(),
				`portikus-check-0123abcd.${config.PREVIEW_SUFFIX}`,
			),
		).toBe(false);
	});

	test("refuses a system listener such as systemd-resolved", async () => {
		const id = await workspace("alice", "running");
		const live = registry([[id, 5355]], [5355]);
		expect(
			await askAllows(
				testDb.db,
				config,
				live,
				new PreviewApprovals(),
				preview("alice", 5355),
			),
		).toBe(false);
	});

	test("caps new names per workspace per hour, but re-approves known names", async () => {
		const alice = await workspace("alice", "running");
		const bob = await workspace("bob", "running");
		const ports = Array.from({ length: 12 }, (_, i) => 3000 + i);
		const live = registry([
			...ports.map((p): [string, number] => [alice, p]),
			[bob, 3000],
		]);
		let clock = 0;
		const warned: string[] = [];
		const approvals = new PreviewApprovals(
			(id) => warned.push(id),
			() => clock,
		);
		const ask = (label: string, port: number) =>
			askAllows(testDb.db, config, live, approvals, preview(label, port));
		for (const port of ports.slice(0, NEW_NAMES_PER_WORKSPACE_PER_HOUR)) {
			expect(await ask("alice", port)).toBe(true);
		}
		expect(await ask("alice", 3010)).toBe(false);
		expect(await ask("alice", 3011)).toBe(false);
		expect(warned).toEqual([alice]);
		expect(await ask("alice", 3000)).toBe(true);
		expect(await ask("bob", 3000)).toBe(true);
		clock = 60 * 60 * 1000;
		expect(await ask("alice", 3010)).toBe(true);
	});
});
