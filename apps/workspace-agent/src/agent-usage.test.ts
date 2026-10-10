/**
 * The coding-agent usage receiver keeps counts and nothing else (ADR 0057,
 * SPEC.md §25.10, STACK.md §15).
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_USAGE_METRICS_PATH,
	AgentUsageReport,
	MAX_AGENT_USAGE_MODELS_PER_DAY,
	MAX_AGENT_USAGE_REPORT_ROWS,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, test, vi } from "vitest";
import {
	AgentUsage,
	buildAgentUsageReceiver,
	MAX_AGENT_USAGE_BODY_BYTES,
	NO_MODEL,
	OtlpMetricsRequest,
	startAgentUsageReceiver,
} from "./agent-usage.js";
import { isSystemListener } from "./listening.js";
import { buildServer } from "./server.js";

const DELTA = 1;
const CUMULATIVE = 2;

type Attrs = Record<string, string | number | boolean>;

function attributes(attrs: Attrs) {
	return Object.entries(attrs).map(([key, value]) => ({
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "number"
					? { intValue: String(value) }
					: { boolValue: value },
	}));
}

function sum(name: string, points: [Attrs, number][], temporality = DELTA) {
	return {
		name,
		unit: "",
		sum: {
			aggregationTemporality: temporality,
			isMonotonic: true,
			dataPoints: points.map(([attrs, value]) => ({
				attributes: attributes(attrs),
				startTimeUnixNano: "1760000000000000000",
				timeUnixNano: "1760000060000000000",
				asDouble: value,
			})),
		},
	};
}

function histogram(name: string, points: [Attrs, number][]) {
	return {
		name,
		histogram: {
			aggregationTemporality: DELTA,
			dataPoints: points.map(([attrs, value]) => ({
				attributes: attributes(attrs),
				count: "1",
				sum: value,
				bucketCounts: ["1"],
				explicitBounds: [],
			})),
		},
	};
}

/** An export as Claude Code and Codex send it, resource attributes and all. */
function exportOf(...metrics: unknown[]) {
	return {
		resourceMetrics: [
			{
				resource: {
					attributes: attributes({
						"service.name": "claude-code",
						"user.email": "student@example.edu",
						"host.name": "ws-secret",
					}),
				},
				scopeMetrics: [{ scope: { name: "com.anthropic.claude_code" }, metrics }],
			},
		],
	};
}

/** What Claude Code attaches to every point; none of it may be kept. */
const IDENTITY = {
	"session.id": "0b8f2e4c-session",
	"user.email": "student@example.edu",
	"user.account_uuid": "acct-uuid",
	"organization.id": "org-id",
	"terminal.type": "tmux",
};

const DAY = "2026-10-10";
const NOON = new Date(`${DAY}T12:00:00Z`);

function receiver(now = () => NOON) {
	const usage = new AgentUsage({ now });
	return { usage, app: buildAgentUsageReceiver(usage) };
}

function post(app: ReturnType<typeof buildAgentUsageReceiver>, body: unknown) {
	return app.inject({
		method: "POST",
		url: AGENT_USAGE_METRICS_PATH,
		headers: { "content-type": "application/json" },
		payload: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const SONNET = "claude-sonnet-5";

describe("the receiver", () => {
	test("keeps Claude Code's allow-listed counters per day, agent and model", async () => {
		const { usage, app } = receiver();
		const res = await post(
			app,
			exportOf(
				sum("claude_code.session.count", [[{ ...IDENTITY, start_type: "fresh" }, 1]]),
				sum("claude_code.token.usage", [
					[{ ...IDENTITY, type: "input", model: SONNET }, 120],
					[{ ...IDENTITY, type: "output", model: SONNET }, 45],
					[{ ...IDENTITY, type: "cacheRead", model: SONNET }, 900],
					[{ ...IDENTITY, type: "cacheCreation", model: SONNET }, 30],
				]),
				sum("claude_code.cost.usage", [[{ ...IDENTITY, model: SONNET }, 0.0125]]),
				sum("claude_code.lines_of_code.count", [
					[{ ...IDENTITY, type: "added", model: SONNET }, 12],
					[{ ...IDENTITY, type: "removed", model: SONNET }, 3],
				]),
			),
		);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({});
		const report = usage.report();
		expect(AgentUsageReport.parse(report)).toEqual(report);
		expect(report.rows).toEqual([
			{
				day: DAY,
				agent: "claude",
				model: NO_MODEL,
				sessions: 1,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
				linesAdded: 0,
				linesRemoved: 0,
			},
			{
				day: DAY,
				agent: "claude",
				model: SONNET,
				sessions: 0,
				inputTokens: 120,
				outputTokens: 45,
				cacheReadTokens: 900,
				cacheWriteTokens: 30,
				costUsd: 0.0125,
				linesAdded: 12,
				linesRemoved: 3,
			},
		]);
	});

	test("keeps running totals across exports, and starts a new row on a new UTC day", async () => {
		let now = new Date(`${DAY}T23:59:00Z`);
		const { usage, app } = receiver(() => now);
		const tokens = exportOf(
			sum("claude_code.token.usage", [[{ type: "output", model: SONNET }, 10]]),
		);
		await post(app, tokens);
		await post(app, tokens);
		now = new Date("2026-10-11T00:01:00Z");
		await post(app, tokens);
		expect(usage.report().rows.map((r) => [r.day, r.outputTokens])).toEqual([
			[DAY, 20],
			["2026-10-11", 10],
		]);
	});

	test("keeps Codex's thread count and token histogram sums, input net of cache reads", async () => {
		const { usage, app } = receiver();
		const codex = {
			model: "gpt-6-codex",
			auth_mode: "chatgpt",
			originator: "codex_cli_rs",
		};
		await post(
			app,
			exportOf(
				sum("codex.thread.started", [[{ ...codex, is_git: "true" }, 1]]),
				histogram("codex.turn.token_usage", [
					[{ ...codex, token_type: "total" }, 1500],
					[{ ...codex, token_type: "input" }, 1000],
					[{ ...codex, token_type: "cached_input" }, 600],
					[{ ...codex, token_type: "cache_write_input" }, 50],
					[{ ...codex, token_type: "output" }, 500],
					[{ ...codex, token_type: "reasoning_output" }, 200],
				]),
				sum("codex.tool.call", [[{ ...codex, tool: "shell" }, 4]]),
			),
		);
		expect(usage.report().rows).toEqual([
			{
				day: DAY,
				agent: "codex",
				model: "gpt-6-codex",
				sessions: 1,
				inputTokens: 400,
				outputTokens: 500,
				cacheReadTokens: 600,
				cacheWriteTokens: 50,
				costUsd: null,
				linesAdded: 0,
				linesRemoved: 0,
			},
		]);
	});

	test("drops content-bearing payloads: prompt text, emails and session ids are never kept", async () => {
		const { usage, app } = receiver();
		const prompt = "please fix my secret-project.py";
		const res = await post(app, {
			...exportOf(
				sum("claude_code.token.usage", [
					[
						{ ...IDENTITY, type: "input", model: SONNET, prompt, prompt_text: prompt },
						7,
					],
				]),
				sum("claude_code.user_prompt", [[{ ...IDENTITY, prompt }, 1]]),
			),
			// An event export posted to the metrics path is not a metric.
			resourceLogs: [
				{ scopeLogs: [{ logRecords: [{ body: { stringValue: prompt } }] }] },
			],
		});
		expect(res.statusCode).toBe(200);
		const kept = JSON.stringify(usage.report());
		for (const secret of [
			prompt,
			"student@example.edu",
			"0b8f2e4c-session",
			"acct-uuid",
			"org-id",
			"ws-secret",
			"tmux",
		]) {
			expect(kept).not.toContain(secret);
		}
		expect(usage.report().rows).toHaveLength(1);
		expect(usage.report().rows[0]?.inputTokens).toBe(7);
	});

	test("drops metrics outside the allow-list and attribute values outside the known ones", async () => {
		const { usage, app } = receiver();
		await post(
			app,
			exportOf(
				sum("claude_code.commit.count", [[{}, 5]]),
				sum("claude_code.active_time.total", [[{}, 300]]),
				sum("my.forged.metric", [[{ model: SONNET }, 9]]),
				sum("claude_code.token.usage", [[{ type: "everything", model: SONNET }, 9]]),
				sum("claude_code.lines_of_code.count", [[{ type: "moved", model: SONNET }, 9]]),
				sum("claude_code.session.count", [[{ start_type: "agents_view" }, 1]]),
			),
		);
		expect(
			usage.report().rows.every((r) => r.sessions === 0 && r.inputTokens === 0),
		).toBe(true);
		expect(usage.report().rows.filter((r) => r.model === SONNET)).toEqual([]);
	});

	test("drops cumulative, negative, non-finite and badly named points", async () => {
		const { usage, app } = receiver();
		await post(
			app,
			exportOf(
				sum(
					"claude_code.token.usage",
					[[{ type: "input", model: SONNET }, 50]],
					CUMULATIVE,
				),
				sum("claude_code.token.usage", [
					[{ type: "input", model: SONNET }, -5],
					[{ type: "input", model: "has space" }, 5],
					[{ type: "input", model: "x".repeat(101) }, 5],
				]),
			),
		);
		await post(app, {
			resourceMetrics: [
				{
					scopeMetrics: [
						{
							metrics: [
								{
									name: "claude_code.token.usage",
									sum: {
										aggregationTemporality: DELTA,
										dataPoints: [
											{
												attributes: attributes({ type: "input", model: SONNET }),
												asDouble: "Infinity",
											},
										],
									},
								},
							],
						},
					],
				},
			],
		});
		expect(usage.report().rows).toEqual([]);
	});

	test(`keeps at most ${MAX_AGENT_USAGE_MODELS_PER_DAY} models a day per agent`, async () => {
		const { usage, app } = receiver();
		const points: [Attrs, number][] = Array.from({ length: 60 }, (_, i) => [
			{ type: "output", model: `model-${i}` },
			1,
		]);
		await post(app, exportOf(sum("claude_code.token.usage", points)));
		await post(
			app,
			exportOf(sum("codex.thread.started", [[{ model: "gpt-6-codex" }, 1]])),
		);
		const rows = usage.report().rows;
		expect(rows.filter((r) => r.agent === "claude")).toHaveLength(
			MAX_AGENT_USAGE_MODELS_PER_DAY,
		);
		// The cap is per agent, so Codex still gets its row.
		expect(rows.filter((r) => r.agent === "codex")).toHaveLength(1);
	});

	test("forgets old days so a long-running agent's report stays under the row cap", async () => {
		let now = NOON;
		const { usage, app } = receiver(() => now);
		const models = Array.from(
			{ length: MAX_AGENT_USAGE_MODELS_PER_DAY },
			(_, i): [Attrs, number] => [{ type: "output", model: `m-${i}` }, 1],
		);
		const both = exportOf(
			sum("claude_code.token.usage", models),
			sum(
				"codex.thread.started",
				models.map(([attrs]) => [{ model: attrs.model as string }, 1]),
			),
		);
		for (let day = 0; day < 45; day++) {
			now = new Date(NOON.getTime() + day * 86_400_000);
			await post(app, both);
		}
		const report = usage.report();
		expect(report.rows).toHaveLength(MAX_AGENT_USAGE_REPORT_ROWS);
		expect(AgentUsageReport.safeParse(report).success).toBe(true);
		expect(report.rows.some((r) => r.day === DAY)).toBe(false);
	});

	test("refuses a body over 1 MiB, a non-JSON body and a malformed one", async () => {
		const { usage, app } = receiver();
		const big = JSON.stringify({
			resourceMetrics: [],
			padding: "x".repeat(MAX_AGENT_USAGE_BODY_BYTES),
		});
		expect((await post(app, big)).statusCode).toBe(413);
		const protobuf = await app.inject({
			method: "POST",
			url: AGENT_USAGE_METRICS_PATH,
			headers: { "content-type": "application/x-protobuf" },
			payload: Buffer.from([0x0a, 0x00]),
		});
		expect(protobuf.statusCode).toBe(415);
		expect((await post(app, "{not json")).statusCode).toBe(400);
		expect(
			(await post(app, { resourceMetrics: [{ scopeMetrics: "no" }] })).statusCode,
		).toBe(400);
		expect(usage.report().rows).toEqual([]);
	});

	test("answers only the metrics path", async () => {
		const { app } = receiver();
		const res = await app.inject({ method: "POST", url: "/v1/logs", payload: {} });
		expect(res.statusCode).toBe(404);
	});

	test("reports a random boot id, fresh for each start", () => {
		const a = new AgentUsage();
		const b = new AgentUsage();
		expect(a.report().bootId).toMatch(/^[0-9a-f-]{36}$/);
		expect(a.report().bootId).not.toBe(b.report().bootId);
	});
});

describe("listening", () => {
	test("listens on loopback, and a taken port is logged rather than fatal", async () => {
		const { app } = receiver();
		await startAgentUsageReceiver(app, 0, silentLogger() as FastifyBaseLogger);
		const address = app.server.address() as AddressInfo;
		expect(address.address).toBe("127.0.0.1");

		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const taken = (blocker.address() as AddressInfo).port;
		const warn = vi.fn();
		const second = receiver().app;
		await expect(
			startAgentUsageReceiver(second, taken, { warn } as unknown as FastifyBaseLogger),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ port: taken }),
			"agent usage receiver could not listen",
		);
		await app.close();
		await second.close();
		await new Promise((resolve) => blocker.close(resolve));
	});

	test("the agent's own listener is a system listener, hidden from the Running pane", () => {
		// The receiver runs in the agent process, which runs as the student.
		expect(
			isSystemListener({ ownerPid: process.pid, uids: [1000], hasContainer: false }),
		).toBe(true);
	});
});

describe("GET /agent-usage", () => {
	test("returns the report to a caller with the token, and nothing without it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "portikus-agent-usage-"));
		const tokenPath = join(dir, "agent.token");
		const token = "u".repeat(64);
		await writeFile(tokenPath, token);
		const usage = new AgentUsage({ now: () => NOON });
		usage.ingest(
			OtlpMetricsRequest.parse(
				exportOf(
					sum("claude_code.token.usage", [[{ type: "output", model: SONNET }, 3]]),
				),
			),
		);
		const app = buildServer({
			tmuxSocketName: "portikus-test",
			tokenPath,
			homeDir: dir,
			listening: { procRoot: dir, interfaceAddress: null, docker: null },
			agentUsage: usage,
		});
		try {
			const anonymous = await app.inject({ method: "GET", url: "/agent-usage" });
			expect(anonymous.statusCode).toBe(401);
			const res = await app.inject({
				method: "GET",
				url: "/agent-usage",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(res.statusCode).toBe(200);
			const report = AgentUsageReport.parse(res.json());
			expect(report.bootId).toBe(usage.bootId);
			expect(report.rows).toEqual([
				expect.objectContaining({ model: SONNET, outputTokens: 3 }),
			]);
		} finally {
			await app.close();
		}
	});
});
