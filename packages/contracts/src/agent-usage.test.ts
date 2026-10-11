import { expect, test } from "vitest";
import {
	AgentUsageQuery,
	AgentUsageReport,
	AgentUsageResponse,
	MAX_AGENT_USAGE_MODEL_LENGTH,
	MAX_AGENT_USAGE_REPORT_ROWS,
} from "./agent-usage.js";

const counts = {
	sessions: 2,
	inputTokens: 1200,
	outputTokens: 800,
	cacheReadTokens: 5000,
	cacheWriteTokens: 300,
	costUsd: 0.42,
	linesAdded: 40,
	linesRemoved: 7,
};

const row = { ...counts, day: "2026-10-10", agent: "claude", model: "claude-opus-5-5" };
const bootId = "850e8400-e29b-41d4-a716-446655440000";

test("an agent usage report round-trips", () => {
	const body = {
		bootId,
		rows: [row, { ...row, agent: "codex", model: "gpt-5-codex", costUsd: null }],
	};
	expect(AgentUsageReport.parse(body)).toEqual(body);
});

test("a report keeps counts only", () => {
	const parsed = AgentUsageReport.parse({
		bootId,
		rows: [
			{ ...row, prompt: "fix my code", sessionId: "s-1", email: "sam@example.test" },
		],
	});
	expect(parsed.rows[0]).toEqual(row);
});

test("a report refuses bad rows", () => {
	for (const bad of [
		{ ...row, agent: "copilot" },
		{ ...row, model: "" },
		{ ...row, model: "m".repeat(MAX_AGENT_USAGE_MODEL_LENGTH + 1) },
		{ ...row, model: "two words" },
		{ ...row, model: "bad\u0007bell" },
		{ ...row, day: "10/10/2026" },
		{ ...row, inputTokens: -1 },
		{ ...row, sessions: 1.5 },
		{ ...row, costUsd: -0.01 },
	]) {
		expect(AgentUsageReport.safeParse({ bootId, rows: [bad] }).success).toBe(false);
	}
	expect(AgentUsageReport.safeParse({ bootId: "boot-1", rows: [] }).success).toBe(
		false,
	);
});

test("a report has a row limit", () => {
	const rows = Array.from({ length: MAX_AGENT_USAGE_REPORT_ROWS + 1 }, () => row);
	expect(AgentUsageReport.safeParse({ bootId, rows }).success).toBe(false);
	expect(AgentUsageReport.safeParse({ bootId, rows: rows.slice(1) }).success).toBe(
		true,
	);
});

test("the usage query takes 7, 30 or 90 days and defaults to 7", () => {
	expect(AgentUsageQuery.parse({})).toEqual({ days: 7 });
	expect(AgentUsageQuery.parse({ days: "30" })).toEqual({ days: 30 });
	expect(AgentUsageQuery.parse({ days: "90" })).toEqual({ days: 90 });
	for (const days of ["1", "365", "abc", "7.0"]) {
		expect(AgentUsageQuery.safeParse({ days }).success).toBe(false);
	}
});

test("a usage response round-trips", () => {
	const body = {
		days: 30,
		from: "2026-09-11",
		to: "2026-10-10",
		users: [
			{
				...counts,
				userId: "650e8400-e29b-41d4-a716-446655440001",
				displayName: "Sam Student",
				agent: "claude",
			},
			{
				...counts,
				costUsd: null,
				userId: "650e8400-e29b-41d4-a716-446655440001",
				displayName: "Sam Student",
				agent: "codex",
			},
		],
		daily: [{ ...counts, day: "2026-10-10", agent: "claude" }],
	};
	expect(AgentUsageResponse.parse(body)).toEqual(body);
	expect(AgentUsageResponse.safeParse({ ...body, days: 14 }).success).toBe(false);
});
