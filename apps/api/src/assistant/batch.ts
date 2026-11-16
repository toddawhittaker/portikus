import type { OperationInputValues, RunResult } from "../catalog/run.js";

/**
 * Bulk work through one approval (SPEC.md section 20.4): the person approves
 * a table of rows once, and each row then runs as its own call through the
 * operation's route, so each row has its own checks and its own audit row.
 */

/** The assistant-only tool; a stored approval for it carries this as its operation. */
export const BATCH_TOOL = "run_batch";

export const BATCH_DESCRIPTION =
	"Runs one change or destructive operation once for each of up to 100 rows, after one approval from the person, " +
	"who sees the whole table first. Each row is the input run_operation takes for that operation " +
	"(path values, query values and a JSON body). Every row is checked before anything runs, and one bad row stops the whole call. " +
	"Read operations cannot be batched; call them one at a time. " +
	"When the person asks for the same kind of change to several items (for example inviting several people), " +
	"use run_batch with one row each so they approve once, instead of separate calls.";

type Check = (raw: unknown) => { input: OperationInputValues } | { problem: string };

/** Every row's checked input, or one problem naming each bad row by its number (from 1). */
export function checkRows(
	rows: readonly unknown[],
	check: Check,
): { inputs: OperationInputValues[] } | { problem: string } {
	const inputs: OperationInputValues[] = [];
	const problems: string[] = [];
	rows.forEach((raw, at) => {
		const checked = check(raw);
		if ("problem" in checked) problems.push(`row ${at + 1}: ${checked.problem}`);
		else inputs.push(checked.input);
	});
	if (problems.length > 0) {
		return {
			problem: `Nothing ran. ${problems.length === 1 ? "One row is" : `${problems.length} rows are`} not valid: ${problems.join(" ")}`,
		};
	}
	return { inputs };
}

type RowStatus = "ok" | "refused" | "failed" | "not run";

export type RowResult = { row: number; status: RowStatus; code: string | null };

/** The refusal code a route's error body names, if any. */
function codeOf(result: RunResult): string | null {
	if (!result.ok) return result.error.code;
	if (result.status < 400) return null;
	try {
		const code = (JSON.parse(result.body) as { code?: unknown } | null)?.code;
		return typeof code === "string" ? code : "INTERNAL";
	} catch {
		return "INTERNAL";
	}
}

function statusOf(result: RunResult): RowStatus {
	if (!result.ok) return "refused";
	if (result.status < 400) return "ok";
	return result.status < 500 ? "refused" : "failed";
}

/** The code a row not reached carries when the session ended before it. */
const SESSION_ENDED_CODE = "SESSION_ENDED";

/**
 * Run the rows one at a time, in order. A refused or failed row does not stop
 * the rest; a 401 means the session ended, so no later row may run.
 */
export async function runRows(
	inputs: readonly OperationInputValues[],
	run: (input: OperationInputValues) => Promise<RunResult>,
): Promise<RowResult[]> {
	const results: RowResult[] = [];
	let ended = false;
	for (const [at, input] of inputs.entries()) {
		const row = at + 1;
		if (ended) {
			results.push({ row, status: "not run", code: SESSION_ENDED_CODE });
			continue;
		}
		const result = await run(input);
		results.push({ row, status: statusOf(result), code: codeOf(result) });
		if (result.ok && result.status === 401) ended = true;
	}
	return results;
}

/** What the model reads and what is stored: a per-row table of status and refusal code. */
export function resultsText(operation: string, results: readonly RowResult[]): string {
	return JSON.stringify({
		operation,
		rows: results.length,
		ok: results.filter((r) => r.status === "ok").length,
		results,
	});
}

export function allOk(results: readonly RowResult[]): boolean {
	return results.every((r) => r.status === "ok");
}
