import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { expect, test } from "vitest";
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
