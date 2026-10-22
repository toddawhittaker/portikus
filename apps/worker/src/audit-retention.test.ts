import type { TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, expect, test, vi } from "vitest";
import {
	AUDIT_PRUNE_BATCH,
	AUDIT_PRUNE_SECONDS,
	startAuditRetention,
} from "./audit-retention.js";

// SPEC.md 25.10: the sweep runs once a day. The deletes themselves run under
// the worker's role, so grants.test.ts holds the database tests.

afterEach(() => {
	vi.useRealTimers();
});

test("the sweep runs daily, in batches of 5000", () => {
	expect(AUDIT_PRUNE_SECONDS).toBe(86_400);
	expect(AUDIT_PRUNE_BATCH).toBe(5000);
});

test("a failing sweep is logged and does not throw", async () => {
	const { logger, lines } = collectingLogger();
	const stop = startAuditRetention({ db: {} as TestDb["db"], logger });
	await vi.waitFor(() =>
		expect(lines.some((l) => l.msg === "audit retention error")).toBe(true),
	);
	stop();
});

test("the sweep runs once at start, then once every 24 hours until stopped", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let calls = 0;
	const tick = async () => {
		calls++;
	};
	const { logger } = collectingLogger();
	const stop = startAuditRetention({ db: {} as TestDb["db"], logger }, tick);
	expect(calls).toBe(1);
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 1000 - 1);
	expect(calls).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(calls).toBe(2);
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 1000);
	expect(calls).toBe(3);
	stop();
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 5000);
	expect(calls).toBe(3);
});
