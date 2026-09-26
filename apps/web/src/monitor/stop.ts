/**
 * Stopping one of the student's own processes from Monitor (SPEC.md §18.3;
 * docs/EPIC-21.md ruling 20). The start ticks travel with the PID so a
 * reused PID is refused rather than signalled.
 */
import { ProcessStopResponse } from "@portikus/contracts";
import { ApiError, request } from "../api/request.js";

export function stopProcess(
	workspaceId: string,
	pid: number,
	startTicks: number,
	force: boolean,
): Promise<ProcessStopResponse> {
	return request(
		ProcessStopResponse,
		`/workspaces/${workspaceId}/processes/${pid}/stop`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ startTicks, force }),
		},
	);
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
