import type { CheckState } from "@portikus/contracts";

/** What a check's badge says, and which colour it borrows (DESIGN.md §6). */
export const CHECK_BADGE: Record<
	CheckState | "idle",
	{ state: "stopped" | "starting" | "running" | "error"; label: string }
> = {
	idle: { state: "stopped", label: "Not run yet" },
	running: { state: "starting", label: "Running" },
	passed: { state: "running", label: "Passed" },
	failed: { state: "error", label: "Failed" },
	error: { state: "error", label: "Could not run" },
	stopped: { state: "stopped", label: "Stopped" },
};
