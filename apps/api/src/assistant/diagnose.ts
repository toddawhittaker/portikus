import { randomUUID } from "node:crypto";
import { type AssistantContext, SiteJobKind } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { operationByName } from "../catalog/index.js";
import { type OperationInputValues, runOperation } from "../catalog/run.js";
import { toolResult } from "../mcp/result.js";
import { toolName } from "../mcp/server.js";
import type { AssistantHub } from "./hub.js";
import type { TurnCaller } from "./loop.js";
import { loadEvents, nameConversation, touchConversation } from "./store.js";
import { RUN_TOOL, textOf } from "./tools.js";

/**
 * Diagnose (SPEC.md section 20.5): a conversation opened on one item runs a
 * fixed list of read operations first, as the person, and stores each as an
 * ordinary tool call they can expand. Then the model is asked, once, for the
 * likely cause. Every operation here only reads, and the conversation is
 * read-only besides, so no card can come of it.
 */

type Read = { operation: string; input: OperationInputValues };

export type DiagnosePlan = {
	/** The first message, which also names the conversation. */
	request: string;
	/** What the model is asked once the reads are in. */
	prompt: string;
	reads: Read[];
};

/** About a screenful per read, so five reads never swamp the model's context. */
const DIAGNOSE_RESULT_CHARS = 6000;

const FAILED_TEXT = "Something went wrong, and the assistant stopped.";

const UuidText = z.string().uuid();

const ERROR_LOGS: Read = {
	operation: "logs.list",
	input: { query: { level: "error" } },
};

function instructions(subject: string): string {
	return (
		`What is the most likely cause for ${subject}? Use only the reads above, cite each by ` +
		"its tool name and the part of its result, and say what to check next. If they show " +
		"no problem, say so."
	);
}

/** The operations that show the state a failed site job was changing. */
const SITE_JOB_READS: Record<SiteJobKind, string[]> = {
	"proxy-hosts": ["proxy_hosts.get"],
	"lti-platforms": ["lms.get"],
	address: ["address.get"],
	signin: ["signin.get"],
	keep: ["address.get", "signin.get"],
	rollback: ["address.get", "signin.get"],
};

/**
 * A job's context id is `certificate:<id>`, `image:<id>` or `site:<kind>`:
 * the id alone does not say which job table it came from.
 */
function jobPlan(id: string): DiagnosePlan | null {
	const [kind, value, ...rest] = id.split(":");
	if (rest.length > 0 || value === undefined) return null;
	if (kind === "certificate" || kind === "image") {
		if (!UuidText.safeParse(value).success) return null;
		return {
			request: `Diagnose a failed ${kind} job`,
			prompt: instructions(`this ${kind} job`),
			reads: [
				{ operation: `${kind}.get_job`, input: { path: { id: value } } },
				ERROR_LOGS,
			],
		};
	}
	const site = kind === "site" ? SiteJobKind.safeParse(value) : null;
	if (!site?.success) return null;
	return {
		request: `Diagnose a failed ${site.data} change`,
		prompt: instructions("this site change"),
		reads: [
			...SITE_JOB_READS[site.data].map((operation) => ({ operation, input: {} })),
			ERROR_LOGS,
		],
	};
}

/**
 * The reads for a context, or null when its id is not one this kind can
 * name. The route refuses such a context before a conversation exists.
 */
export function planDiagnose(context: AssistantContext): DiagnosePlan | null {
	const { kind, id } = context;
	if (kind === "health") {
		return {
			request: "Diagnose the site's health",
			prompt: instructions("the site's health"),
			reads: [
				{ operation: "health.get", input: {} },
				{ operation: "health.series", input: { query: { range: "1h" } } },
				ERROR_LOGS,
			],
		};
	}
	if (id === undefined) return null;
	if (kind === "workspace") {
		if (!UuidText.safeParse(id).success) return null;
		return {
			request: `Diagnose workspace ${id.slice(0, 8)}`,
			prompt: instructions("this workspace"),
			reads: [
				{ operation: "workspaces.get_detail", input: { path: { id } } },
				{ operation: "workspaces.agent_log", input: { path: { id } } },
				{ operation: "workspaces.list_processes", input: { path: { id } } },
				{ operation: "audit.list", input: { query: { workspace: id } } },
			],
		};
	}
	if (kind === "job") return jobPlan(id);
	// An alert is one of the person's notifications; it carries no pointer, so the
	// site's current health and errors are the evidence to set beside it.
	if (!UuidText.safeParse(id).success) return null;
	return {
		request: `Diagnose alert ${id.slice(0, 8)}`,
		prompt: instructions(`the alert with id ${id}`),
		reads: [
			{ operation: "notifications.list", input: { query: { limit: 50 } } },
			{ operation: "health.get", input: {} },
			ERROR_LOGS,
		],
	};
}

function capped(text: string): string {
	if (text.length <= DIAGNOSE_RESULT_CHARS) return text;
	return `${text.slice(0, DIAGNOSE_RESULT_CHARS)}\n[Truncated: the answer was ${text.length} characters and only the first ${DIAGNOSE_RESULT_CHARS} are shown.]`;
}

export type DiagnoseDeps = {
	app: FastifyInstance;
	db: Kysely<Database>;
	hub: AssistantHub;
	/** The loop's own send: stores the prompt and runs the model on it. */
	send: (caller: TurnCaller, text: string) => Promise<void>;
};

type Prepared = {
	id: string;
	name: string;
	title: string;
	input: Record<string, unknown>;
	read: Read;
};

/** A read as the model would have called it: the named tool when there is one, else `run_operation`. */
function prepare(read: Read): Prepared | null {
	const operation = operationByName(read.operation)?.operation;
	if (operation?.risk !== "read") return null;
	return {
		id: randomUUID(),
		name: operation.tool ? toolName(operation) : RUN_TOOL,
		title: operation.description,
		input: operation.tool
			? { ...read.input }
			: { operation: operation.name, input: read.input },
		read,
	};
}

/**
 * Run a Diagnose conversation's reads and then ask the model, once. It does
 * nothing when the conversation already has events (a second tab, or a
 * reconnect) or a turn is running, so each conversation is diagnosed once.
 */
export async function startDiagnose(
	deps: DiagnoseDeps,
	caller: TurnCaller,
	context: AssistantContext,
): Promise<void> {
	const { app, db, hub } = deps;
	const id = caller.conversationId;
	const plan = planDiagnose(context);
	if (!plan) return;
	const turn = hub.beginTurn(id);
	if (!turn) return;
	let prompt = false;
	try {
		if ((await loadEvents(db, id)).length > 0) return;
		await hub.emit(id, { type: "turn.started", at: Date.now() });
		await hub.emit(id, {
			type: "message",
			id: randomUUID(),
			role: "user",
			markdown: plan.request,
		});
		await nameConversation(db, id, plan.request);
		await touchConversation(db, id);
		const calls = plan.reads.flatMap((read) => prepare(read) ?? []);
		for (const call of calls) {
			await hub.emit(id, {
				type: "tool.started",
				id: call.id,
				name: call.name,
				title: call.title,
				input: JSON.parse(JSON.stringify(call.input)),
			});
		}
		for (const call of calls) {
			// A stopped turn still closes every call it showed.
			const result = turn.signal.aborted
				? null
				: toolResult(
						await runOperation(
							app,
							db,
							caller.run,
							call.read.operation,
							call.read.input,
						),
					);
			if (result) {
				await hub.emit(id, {
					type: "tool.output",
					id: call.id,
					part: { type: "text", text: capped(textOf(result)) },
				});
			}
			await hub.emit(id, {
				type: "tool.finished",
				id: call.id,
				isError: result === null || result.isError === true,
			});
		}
		const status = turn.signal.aborted ? "interrupted" : "done";
		await hub.emit(id, { type: "turn.finished", status, at: Date.now() });
		prompt = status === "done";
	} catch (error) {
		app.log.error(
			{ conversationId: id, error: error instanceof Error ? error.name : "unknown" },
			"assistant diagnose failed",
		);
		await hub.emit(id, { type: "error", message: FAILED_TEXT }).catch(() => {});
		await hub
			.emit(id, { type: "turn.finished", status: "error", at: Date.now() })
			.catch(() => {});
	} finally {
		hub.endTurn(id);
	}
	if (prompt) await deps.send(caller, plan.prompt);
}
