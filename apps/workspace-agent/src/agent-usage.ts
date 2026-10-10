import { randomUUID } from "node:crypto";
import {
	AGENT_USAGE_METRICS_PATH,
	AGENT_USAGE_REPORT_DAYS,
	type AgentUsageCounts,
	AgentUsageModel,
	type AgentUsageReport,
	type AgentUsageReportRow,
	type CodingAgent,
	MAX_AGENT_USAGE_MODELS_PER_DAY,
} from "@portikus/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * Coding-agent usage counters, fed by Claude Code and Codex exporting
 * OpenTelemetry metrics as OTLP/HTTP JSON to a loopback port (ADR 0057,
 * SPEC.md §25.10). Only allow-listed counters survive; every other metric,
 * event and attribute, the email and session ids among them, is dropped on
 * arrival and never stored or logged. Any process in the workspace can post
 * here, so the counts are for reporting, never enforcement.
 */

/** Largest request body taken; a real export is a few kilobytes. */
export const MAX_AGENT_USAGE_BODY_BYTES = 1024 * 1024;

/** The model bucket for counters that name none, such as Claude Code's session count. */
export const NO_MODEL = "(none)";

// The OTLP JSON shapes read here. Zod strips every key not named, so
// resource attributes, scopes, exemplars and unknown attribute kinds go.
const Attribute = z.object({
	key: z.string(),
	value: z.object({ stringValue: z.string().optional() }).optional(),
});
// int64 and double may arrive as JSON strings ("NaN", "Infinity", big ints).
const Numeric = z.union([z.number(), z.string().max(40)]);
const Temporality = z.union([z.number(), z.string().max(40)]).optional();
const NumberPoint = z.object({
	attributes: z.array(Attribute).optional(),
	asInt: Numeric.optional(),
	asDouble: Numeric.optional(),
});
const HistogramPoint = z.object({
	attributes: z.array(Attribute).optional(),
	sum: Numeric.optional(),
});
const Metric = z.object({
	name: z.string(),
	sum: z
		.object({
			dataPoints: z.array(NumberPoint).optional(),
			aggregationTemporality: Temporality,
		})
		.optional(),
	histogram: z
		.object({
			dataPoints: z.array(HistogramPoint).optional(),
			aggregationTemporality: Temporality,
		})
		.optional(),
});
export const OtlpMetricsRequest = z.object({
	resourceMetrics: z
		.array(
			z.object({
				scopeMetrics: z
					.array(z.object({ metrics: z.array(Metric).optional() }))
					.optional(),
			}),
		)
		.optional(),
});
export type OtlpMetricsRequest = z.infer<typeof OtlpMetricsRequest>;
type Metric = z.infer<typeof Metric>;
type Attribute = z.infer<typeof Attribute>;

type CountField = Exclude<keyof AgentUsageCounts, "costUsd">;

/** A counter a data point feeds. Codex's raw input is netted against cache reads at report time. */
type Field = CountField | "costUsd" | "codexRawInput";

const CLAUDE_TOKEN_TYPES: Record<string, Field> = {
	input: "inputTokens",
	output: "outputTokens",
	cacheRead: "cacheReadTokens",
	cacheCreation: "cacheWriteTokens",
};
const CLAUDE_LINE_TYPES: Record<string, Field> = {
	added: "linesAdded",
	removed: "linesRemoved",
};
const CODEX_TOKEN_TYPES: Record<string, Field> = {
	input: "codexRawInput",
	cached_input: "cacheReadTokens",
	cache_write_input: "cacheWriteTokens",
	output: "outputTokens",
};

/**
 * The allow-list: which counter a point of a metric feeds, or undefined to
 * drop it. The `claude agents` dashboard is a UI process, not a session.
 */
function fieldOf(
	metric: string,
	attributes: Attribute[] | undefined,
): Field | undefined {
	const kind = (key: string) => attribute(attributes, key) ?? "";
	switch (metric) {
		case "claude_code.session.count":
			return kind("start_type") === "agents_view" ? undefined : "sessions";
		case "claude_code.token.usage":
			return CLAUDE_TOKEN_TYPES[kind("type")];
		case "claude_code.lines_of_code.count":
			return CLAUDE_LINE_TYPES[kind("type")];
		case "claude_code.cost.usage":
			return "costUsd";
		case "codex.thread.started":
			return "sessions";
		case "codex.turn.token_usage":
			return CODEX_TOKEN_TYPES[kind("token_type")];
		default:
			return undefined;
	}
}

type Point = { attributes?: Attribute[]; value: number | string | undefined };

/** A metric's points and their values; a cumulative metric's points are dropped. */
function deltaPoints(metric: Metric): Point[] {
	const points: Point[] = [];
	if (metric.sum && isDelta(metric.sum.aggregationTemporality)) {
		for (const p of metric.sum.dataPoints ?? []) {
			points.push({ attributes: p.attributes, value: p.asInt ?? p.asDouble });
		}
	}
	if (metric.histogram && isDelta(metric.histogram.aggregationTemporality)) {
		for (const p of metric.histogram.dataPoints ?? []) {
			points.push({ attributes: p.attributes, value: p.sum });
		}
	}
	return points;
}

function agentOf(metric: string): CodingAgent | undefined {
	if (metric.startsWith("claude_code.")) return "claude";
	if (metric.startsWith("codex.")) return "codex";
	return undefined;
}

/** Each export is a delta since the last; a cumulative one would count twice. */
function isDelta(temporality: number | string | undefined): boolean {
	return temporality === 1 || temporality === "AGGREGATION_TEMPORALITY_DELTA";
}

function attribute(
	attributes: Attribute[] | undefined,
	key: string,
): string | undefined {
	return attributes?.find((a) => a.key === key)?.value?.stringValue;
}

/** A finite, non-negative number, or undefined. */
function amount(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function addCapped(total: number, value: number): number {
	return Math.min(total + value, Number.MAX_SAFE_INTEGER);
}

function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function emptyCounts(agent: CodingAgent): AgentUsageCounts {
	return {
		sessions: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		// Only Claude Code reports a cost.
		costUsd: agent === "claude" ? 0 : null,
		linesAdded: 0,
		linesRemoved: 0,
	};
}

/**
 * A row and, for Codex, its running raw input. Codex counts cache reads
 * inside input and may send the two in different exports, so the
 * subtraction waits for report().
 */
interface KeptRow {
	row: AgentUsageReportRow;
	codexRawInput: number;
}

export interface AgentUsageOptions {
	now?: () => Date;
}

/** Running totals since this agent started, per UTC day, agent and model. */
export class AgentUsage {
	/** Picked at start, so the worker can tell this run's totals from the last. */
	readonly bootId = randomUUID();
	private readonly now: () => Date;
	private readonly days = new Map<string, Map<string, KeptRow>>();

	constructor(options: AgentUsageOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	/** Fold one export into the totals, keeping only the allow-listed counters. */
	ingest(request: OtlpMetricsRequest): void {
		// The day is when the export arrived; a sender's timestamps are not trusted.
		const day = utcDay(this.now());
		for (const resource of request.resourceMetrics ?? []) {
			for (const scope of resource.scopeMetrics ?? []) {
				for (const metric of scope.metrics ?? []) {
					this.ingestMetric(day, metric);
				}
			}
		}
	}

	private ingestMetric(day: string, metric: Metric): void {
		const agent = agentOf(metric.name);
		if (!agent) return;
		for (const point of deltaPoints(metric)) {
			const field = fieldOf(metric.name, point.attributes);
			const model = modelOf(point.attributes);
			const value = amount(point.value);
			if (!field || !model || value === undefined) continue;
			const kept = this.row(day, agent, model);
			if (!kept) continue;
			if (field === "costUsd") {
				kept.row.costUsd = addCapped(kept.row.costUsd ?? 0, value);
			} else if (field === "codexRawInput") {
				kept.codexRawInput = addCapped(kept.codexRawInput, Math.round(value));
			} else {
				kept.row[field] = addCapped(kept.row[field], Math.round(value));
			}
		}
	}

	/** The row for a day, agent and model, or undefined past the model cap. */
	private row(day: string, agent: CodingAgent, model: string): KeptRow | undefined {
		let rows = this.days.get(day);
		if (!rows) {
			rows = new Map();
			this.days.set(day, rows);
			this.forgetOldDays();
		}
		// A model name holds no spaces, so this key is unambiguous.
		const key = `${agent} ${model}`;
		const existing = rows.get(key);
		if (existing) return existing;
		let models = 0;
		for (const kept of rows.values()) if (kept.row.agent === agent) models++;
		if (models >= MAX_AGENT_USAGE_MODELS_PER_DAY) return undefined;
		const kept: KeptRow = {
			row: { day, agent, model, ...emptyCounts(agent) },
			codexRawInput: 0,
		};
		rows.set(key, kept);
		return kept;
	}

	/** The worker has long since read a day this old; drop it to bound the report. */
	private forgetOldDays(): void {
		while (this.days.size > AGENT_USAGE_REPORT_DAYS) {
			const oldest = [...this.days.keys()].sort()[0];
			if (oldest === undefined) return;
			this.days.delete(oldest);
		}
	}

	report(): AgentUsageReport {
		const rows: AgentUsageReportRow[] = [];
		for (const day of this.days.values()) {
			for (const { row, codexRawInput } of day.values()) {
				rows.push(
					row.agent === "codex"
						? { ...row, inputTokens: Math.max(0, codexRawInput - row.cacheReadTokens) }
						: { ...row },
				);
			}
		}
		return { bootId: this.bootId, rows };
	}
}

/** The model a data point names, the no-model bucket when absent, or null when invalid. */
function modelOf(attributes: Attribute[] | undefined): string | null {
	const model = attribute(attributes, "model");
	if (model === undefined) return NO_MODEL;
	return AgentUsageModel.safeParse(model).success ? model : null;
}

/**
 * The loopback OTLP/HTTP receiver. JSON only (Fastify answers 415 to any
 * other type) and at most MAX_AGENT_USAGE_BODY_BYTES (413). It logs
 * nothing: a body is the sender's, and may hold anything.
 */
export function buildAgentUsageReceiver(usage: AgentUsage): FastifyInstance {
	const app = Fastify({ logger: false, bodyLimit: MAX_AGENT_USAGE_BODY_BYTES });
	app.post(AGENT_USAGE_METRICS_PATH, async (request, reply) => {
		const parsed = OtlpMetricsRequest.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({});
		usage.ingest(parsed.data);
		// An empty ExportMetricsServiceResponse: everything was accepted.
		return reply.code(200).send({});
	});
	return app;
}

/**
 * Listen on loopback. A failure is logged and left: the agent serves the
 * workspace without usage counts rather than not at all.
 */
export async function startAgentUsageReceiver(
	receiver: FastifyInstance,
	port: number,
	log: FastifyBaseLogger,
): Promise<void> {
	try {
		await receiver.listen({ host: "127.0.0.1", port });
	} catch (error) {
		log.warn(
			{ port, error: error instanceof Error ? error.message : String(error) },
			"agent usage receiver could not listen",
		);
	}
}
