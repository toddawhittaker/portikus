import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { ClaudeLimitWindows } from "./claude-adapter.js";
import { PlanUsage } from "./plan-usage.js";

const usage = (utilization: number) => ({
	rate_limits_available: true,
	rate_limits: { seven_day: { utilization, resets_at: "2026-12-01T09:00:00Z" } },
});

/** A session whose usage answers wait until the test settles them, in any order. */
function session() {
	const pending: ((value: unknown) => void)[] = [];
	const query = {
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
			new Promise((resolve) => pending.push(resolve)),
	} as unknown as Query;
	return { query, pending };
}

test("a refresh asked for while one is in flight is skipped, so an older answer cannot land last", async () => {
	const posted: ClaudeLimitWindows[] = [];
	const plan = new PlanUsage(async (windows) => {
		posted.push(windows);
	});
	const { query, pending } = session();
	const first = plan.refresh(query, () => true);
	await plan.refresh(query, () => true);
	expect(pending).toHaveLength(1);
	pending[0]?.(usage(20));
	await first;
	expect(posted.map((one) => one.seven_day?.used_percentage)).toEqual([20]);
	const second = plan.refresh(query, () => true);
	expect(pending).toHaveLength(2);
	pending[1]?.(usage(30));
	await second;
	expect(posted.map((one) => one.seven_day?.used_percentage)).toEqual([20, 30]);
});

test("a request past the timeout is given up, its late answer is dropped, and the next one runs", async () => {
	const posted: ClaudeLimitWindows[] = [];
	const plan = new PlanUsage(async (windows) => {
		posted.push(windows);
	}, 20);
	const { query, pending } = session();
	await plan.refresh(query, () => true);
	pending[0]?.(usage(99));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(posted).toEqual([]);
	const next = plan.refresh(query, () => true);
	expect(pending).toHaveLength(2);
	pending[1]?.(usage(40));
	await next;
	expect(posted.map((one) => one.seven_day?.used_percentage)).toEqual([40]);
});

test("an answer for a session that has since been replaced is not applied", async () => {
	const posted: ClaudeLimitWindows[] = [];
	const plan = new PlanUsage(async (windows) => {
		posted.push(windows);
	});
	const { query, pending } = session();
	const call = plan.refresh(query, () => false);
	pending[0]?.(usage(50));
	await call;
	expect(posted).toEqual([]);
});
