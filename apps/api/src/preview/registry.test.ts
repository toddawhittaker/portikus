import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { createListeningRegistry } from "./registry.js";

/**
 * The registry's poll opens one agent socket per running workspace. Two polls
 * at once would each decide the same workspace needs an entry, and the second
 * would overwrite the first, leaving its socket open with nothing holding it
 * (BROWSER-HANDLING.md §11.1).
 */
test("a slow poll is not joined by the next tick", async () => {
	let running = 0;
	let mostAtOnce = 0;
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	// Only the one query the poll makes is needed, so the database is a stub.
	const db = {
		selectFrom: () => ({
			select: () => ({
				where: () => ({
					execute: async () => {
						running += 1;
						mostAtOnce = Math.max(mostAtOnce, running);
						await gate;
						running -= 1;
						return [];
					},
				}),
			}),
		}),
	} as unknown as Kysely<Database>;

	const registry = createListeningRegistry({
		db,
		config: { AGENT_PORT: 7300 } as unknown as ApiConfig,
		logger: collectingLogger().logger,
		pollIntervalMs: 1,
	});

	registry.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(mostAtOnce).toBe(1);
	release();
	await registry.stop();
});

/**
 * A workspace may hold at most eight loopback forwards at once
 * (BROWSER-HANDLING.md §11.1, SPEC.md §24.7). A page inside a preview can ask
 * the bridge for many ports at once, so the cap has to hold when the calls
 * overlap, not only when they arrive one after another.
 */
test("concurrent calls cannot open more forwards than the cap", async () => {
	const AGENT_TOKEN = "registry-cap-token";
	const WORKSPACE = "11111111-1111-4111-8111-111111111111";
	let agent: FakeAgent | null = null;
	agent = await startFakeAgent(AGENT_TOKEN);

	const ports = [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];
	await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: WORKSPACE,
			services: ports.map((port) => ({
				port,
				addresses: ["127.0.0.1"],
				previewReachability: "unknown",
			})),
		}),
	});

	const rows = [
		{
			id: WORKSPACE,
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${WORKSPACE}`,
		},
	];
	const db = {
		selectFrom: () => ({
			select: () => ({ where: () => ({ execute: async () => rows }) }),
		}),
	} as unknown as Kysely<Database>;

	const registry = createListeningRegistry({
		db,
		config: {
			AGENT_PORT: agent.port,
			PREVIEW_PORT_MIN: 1,
			PREVIEW_PORT_MAX: 65535,
			previewDeniedPorts: [],
		} as unknown as ApiConfig,
		logger: collectingLogger().logger,
		pollIntervalMs: 5,
	});
	registry.start();

	// Wait until the registry has the agent's list.
	const deadline = Date.now() + 5000;
	while (registry.services(WORKSPACE).length < ports.length) {
		if (Date.now() > deadline) throw new Error("the registry never saw the list");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	const results = await Promise.allSettled(
		ports.map((port) => registry.ensureReachable(WORKSPACE, port)),
	);
	const opened = results.filter((one) => one.status === "fulfilled").length;
	expect(opened).toBe(8);
	expect(agent.forwards.get(WORKSPACE)?.size ?? 0).toBe(8);

	await registry.stop();
	await agent.close();
});
