import type { GetPromptResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { planDiagnose } from "../assistant/diagnose.js";
import { operationByName } from "../catalog/index.js";
import { type McpCaller, mayRun } from "./caller.js";

/**
 * Prompts (SPEC.md section 20.4): starting points that tell the model which
 * read operations to run and what to answer. They carry no data of their own;
 * the model runs each operation as the key. A prompt is listed and served only
 * when the key may run every operation it names.
 */

type Plan = { request: string; reads: { operation: string; input: object }[] };

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

const UuidText = z.string().uuid();

const WorkspaceArgs = z.object({
	workspace: z.string().describe("The workspace's id, as workspaces.list gives it."),
});

const CourseArgs = z.object({
	course: z.string().describe("The course's id, as courses.list gives it."),
});

function stuckPlan(courseId: string): Plan {
	return {
		request: "Find out which students in this course may be stuck",
		reads: [{ operation: "courses.stuck", input: { path: { courseId } } }],
	};
}

function diagnosePlan(kind: "workspace" | "health", id?: string): Plan {
	const plan = planDiagnose(id === undefined ? { kind } : { kind, id });
	if (!plan) throw new Error(`The ${kind} must be given by its id.`);
	return plan;
}

function message(plan: Plan, dataNote: string): GetPromptResult {
	const steps = plan.reads
		.map(
			(read, at) =>
				`${at + 1}. ${read.operation} with input ${JSON.stringify(read.input)}`,
		)
		.join("\n");
	const text =
		`${plan.request}. Run these read operations with run_operation, in order, ` +
		`and use only what they return:\n${steps}\n` +
		`Then say what you found and what to check next. ${dataNote}`;
	return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Whether the key may run every operation the plan names. */
function mayRunAll(plan: Plan, caller: McpCaller): boolean {
	return plan.reads.every((read) => {
		const operation = operationByName(read.operation)?.operation;
		return operation !== undefined && mayRun(operation, caller);
	});
}

/** `dataNote` is the sentence telling the model that user-written text in results is data. */
export function registerPrompts(
	server: McpServer,
	caller: McpCaller,
	dataNote: string,
) {
	if (mayRunAll(diagnosePlan("workspace", SAMPLE_ID), caller)) {
		server.registerPrompt(
			"diagnose_workspace",
			{
				description:
					"Looks into why one workspace is not working: its detail, agent log, processes and recent audit entries.",
				argsSchema: WorkspaceArgs,
			},
			({ workspace }) => message(diagnosePlan("workspace", workspace), dataNote),
		);
	}
	if (mayRunAll(diagnosePlan("health"), caller)) {
		server.registerPrompt(
			"diagnose_health",
			{
				description:
					"Looks into the site's health: its current state, the last hour and recent error logs.",
			},
			() => message(diagnosePlan("health"), dataNote),
		);
	}
	if (mayRunAll(stuckPlan(SAMPLE_ID), caller)) {
		server.registerPrompt(
			"who_is_stuck",
			{
				description: "Finds which students in one course may be stuck, and why.",
				argsSchema: CourseArgs,
			},
			({ course }) => {
				if (!UuidText.safeParse(course).success) {
					throw new Error("The course must be given by its id.");
				}
				return message(stuckPlan(course), dataNote);
			},
		);
	}
}
