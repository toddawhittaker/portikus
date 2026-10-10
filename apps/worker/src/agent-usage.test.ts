/**
 * The worker stores each workspace's coding-agent usage report as absolute
 * values, so repeated reads never double count, and keeps 365 days
 * (ADR 0057).
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AGENT_USAGE_RETENTION_DAYS,
	type AgentUsageReport,
	type AgentUsageReportRow,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { fetchAgentUsage } from "./agent-client.js";
import {
	AGENT_USAGE_POLL_SECONDS,
	createAgentUsagePoll,
	pruneAgentUsage,
	storeAgentUsage,
} from "./agent-usage.js";

const DAY = "2026-10-10";
const NOW = new Date(`${DAY}T12:00:00Z`);

function row(over: Partial<AgentUsageReportRow> = {}): AgentUsageReportRow {
	return {
		day: DAY,
		agent: "claude",
		model: "claude-sonnet-5",
		sessions: 1,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 900,
		cacheWriteTokens: 20,
		costUsd: 0.25,
		linesAdded: 10,
		linesRemoved: 2,
		...over,
	};
}

function report(rows: AgentUsageReportRow[], bootId = randomUUID()): AgentUsageReport {
	return { bootId, rows };
}

test("usage is read every five minutes and kept 365 days", () => {
	expect(AGENT_USAGE_POLL_SECONDS).toBe(5 * 60);
	expect(AGENT_USAGE_RETENTION_DAYS).toBe(365);
});

describe("fetchAgentUsage", () => {
	async function agentAnswering(body: string, status = 200) {
		let seen = "";
		const server = createServer((req, res) => {
			seen = `${req.method} ${req.url} ${req.headers.authorization}`;
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { server, port: (server.address() as AddressInfo).port, seen: () => seen };
	}

	test("returns a report that fits the contract, with the token", async () => {
		const sent = report([row()]);
		const agent = await agentAnswering(JSON.stringify(sent));
		try {
			expect(await fetchAgentUsage("127.0.0.1", agent.port, "tok")).toEqual(sent);
			expect(agent.seen()).toBe("GET /agent-usage Bearer tok");
		} finally {
			agent.server.close();
		}
	});

	test("an error status or a reply outside the contract is no data", async () => {
		const failing = await agentAnswering("{}", 500);
		const bad = await agentAnswering(JSON.stringify({ bootId: "nope", rows: [] }));
		try {
			expect(await fetchAgentUsage("127.0.0.1", failing.port, "tok")).toBeNull();
			expect(await fetchAgentUsage("127.0.0.1", bad.port, "tok")).toBeNull();
		} finally {
			failing.server.close();
			bad.server.close();
		}
	});
});

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

describe.skipIf(skip)("storing and pruning usage", () => {
	beforeAll(async () => {
		tdb = await createTestDb();
	});
	afterAll(async () => {
		await tdb.close();
	});
	beforeEach(async () => {
		await tdb.truncate();
	});

	async function workspace(address: string, state: "running" | "stopped" = "running") {
		counter++;
		const userId = await insertTestUser(tdb.db);
		await tdb.db
			.insertInto("workspaces")
			.values({
				label: `ws-usage-${counter}`,
				owner_user_id: userId,
				state,
				agent_address: address,
				agent_token: `token-${counter}`,
			})
			.execute();
		return userId;
	}

	/** One user's totals summed across boots, as the usage views read them. */
	async function totals(userId: string) {
		return tdb.db
			.selectFrom("agent_usage_days")
			.select([
				"agent",
				"model",
				sql<number>`sum(sessions)::int`.as("sessions"),
				sql<number>`sum(input_tokens)::int`.as("input"),
				sql<number>`sum(output_tokens)::int`.as("output"),
				sql<string | null>`sum(cost_usd)::text`.as("cost"),
			])
			.where("user_id", "=", userId)
			.groupBy(["agent", "model"])
			.orderBy("agent")
			.execute();
	}

	test("storing the same report twice changes nothing; a later total overwrites", async () => {
		const userId = await workspace("10.200.0.20");
		const bootId = randomUUID();
		await storeAgentUsage(tdb.db, userId, report([row()], bootId), NOW);
		await storeAgentUsage(tdb.db, userId, report([row()], bootId), NOW);
		expect(await totals(userId)).toEqual([
			{
				agent: "claude",
				model: "claude-sonnet-5",
				sessions: 1,
				input: 100,
				output: 50,
				cost: "0.25",
			},
		]);
		await storeAgentUsage(
			tdb.db,
			userId,
			report([row({ sessions: 2, inputTokens: 300, costUsd: 0.75 })], bootId),
			NOW,
		);
		expect(await totals(userId)).toEqual([
			expect.objectContaining({ sessions: 2, input: 300, cost: "0.75" }),
		]);
	});

	test("totals from different boots add up; Codex keeps a null cost", async () => {
		const userId = await workspace("10.200.0.21");
		await storeAgentUsage(tdb.db, userId, report([row()]), NOW);
		await storeAgentUsage(
			tdb.db,
			userId,
			report([
				row({ sessions: 3, inputTokens: 1, outputTokens: 1, costUsd: 1 }),
				row({ agent: "codex", model: "gpt-6-codex", costUsd: null }),
			]),
			NOW,
		);
		expect(await totals(userId)).toEqual([
			{
				agent: "claude",
				model: "claude-sonnet-5",
				sessions: 4,
				input: 101,
				output: 51,
				cost: "1.25",
			},
			{
				agent: "codex",
				model: "gpt-6-codex",
				sessions: 1,
				input: 100,
				output: 50,
				cost: null,
			},
		]);
	});

	test("the poll reads running workspaces only, under their owner; no data keeps the rows", async () => {
		const running = await workspace("10.200.0.22");
		const stopped = await workspace("10.200.0.23", "stopped");
		const answers = new Map<string, AgentUsageReport | null>([
			["10.200.0.22", report([row()])],
			["10.200.0.23", report([row()])],
		]);
		const asked: string[] = [];
		const { logger } = collectingLogger();
		const tick = createAgentUsagePoll({
			db: tdb.db,
			logger,
			readUsage: async (address) => {
				asked.push(address);
				return answers.get(address) ?? null;
			},
			now: () => NOW,
		});
		await tick();
		expect(asked).toEqual(["10.200.0.22"]);
		expect(await totals(running)).toHaveLength(1);
		expect(await totals(stopped)).toEqual([]);

		answers.set("10.200.0.22", null);
		await tick();
		expect(await totals(running)).toHaveLength(1);
	});

	test("the prune deletes days older than 365 and keeps the rest", async () => {
		const userId = await workspace("10.200.0.24");
		const dayAgo = (n: number) =>
			new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
		await storeAgentUsage(
			tdb.db,
			userId,
			report([row({ day: dayAgo(366) }), row({ day: dayAgo(365) }), row({ day: DAY })]),
			NOW,
		);
		await pruneAgentUsage(tdb.db, NOW);
		const days = await tdb.db
			.selectFrom("agent_usage_days")
			.select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"))
			.orderBy("day")
			.execute();
		expect(days.map((d) => d.day)).toEqual([dayAgo(365), DAY]);
	});
});
