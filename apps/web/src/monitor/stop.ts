/**
 * Stopping one of the student's own processes from Monitor, with or without
 * its children, and lowering a tree's priority (SPEC.md §18.3). The start
 * ticks travel with the PID so a reused PID is refused rather than signalled.
 */
import {
	type ProcessIdentity,
	ProcessPriorityResponse,
	ProcessStopResponse,
	ProcessTreeStopResponse,
} from "@portikus/contracts";
import { ApiError, sendJson } from "../api/request.js";

export function stopProcess(
	workspaceId: string,
	pid: number,
	startTicks: number,
	force: boolean,
): Promise<ProcessStopResponse> {
	return sendJson(
		ProcessStopResponse,
		`/workspaces/${workspaceId}/processes/${pid}/stop`,
		{ startTicks, force },
	);
}

/** A Force stop names the survivors of the first stop, since the root has usually gone. */
export function stopProcessTree(
	workspaceId: string,
	pid: number,
	startTicks: number,
	force: boolean,
	remaining: readonly ProcessIdentity[] | null,
): Promise<ProcessTreeStopResponse> {
	return sendJson(
		ProcessTreeStopResponse,
		`/workspaces/${workspaceId}/processes/${pid}/stop-tree`,
		remaining ? { startTicks, force, remaining } : { startTicks, force },
	);
}

export function lowerPriority(
	workspaceId: string,
	pid: number,
	startTicks: number,
): Promise<ProcessPriorityResponse> {
	return sendJson(
		ProcessPriorityResponse,
		`/workspaces/${workspaceId}/processes/${pid}/lower-priority`,
		{ startTicks },
	);
}

/** "1 child process", "2 child processes". */
export function childProcesses(count: number): string {
	return `${count} child ${count === 1 ? "process" : "processes"}`;
}

/** The sentence added when the agent left protected processes in the tree alone. */
export function refusedText(refused: number): string {
	if (refused === 0) return "";
	return refused === 1
		? " One process Portikus needs was left alone."
		: ` ${refused} processes Portikus needs were left alone.`;
}

/** The dialog's words for a refused or failed stop. */
export function stopErrorText(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case "PROCESS_NOT_FOUND":
			return "That program has already stopped.";
		case "PROCESS_CHANGED":
			return "That process ID now belongs to a different program. Refresh and try again.";
		case "PROCESS_PROTECTED":
			return "Portikus needs this process, so it cannot be stopped here.";
		default:
			return "That program could not be stopped. Try again, or end it from a terminal.";
	}
}

/** The announcement for a refused or failed "Lower priority". */
export function priorityErrorText(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case "PROCESS_NOT_FOUND":
			return "That program has already stopped.";
		case "PROCESS_CHANGED":
			return "That process ID now belongs to a different program. Refresh and try again.";
		case "PROCESS_PROTECTED":
			return "Portikus needs this process, so its priority cannot be changed here.";
		default:
			return "The priority could not be lowered. Try again in a moment.";
	}
}
