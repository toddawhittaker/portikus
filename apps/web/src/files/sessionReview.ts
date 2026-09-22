/**
 * The session-review label and which open terminal it belongs to
 * (SPEC.md §10.9, §12.7). The words name the agent session, never Git HEAD.
 */
import type { CodingAgent, Terminal } from "@portikus/contracts";

export function sessionReviewLabel(agent: CodingAgent): string {
	return agent === "claude"
		? "Changes since Claude session started"
		: "Changes since Codex session started";
}

/**
 * The open agent terminal the Changes list can review. The focused terminal
 * wins when it has a baseline; otherwise the newest open one that does.
 */
export function openAgentSession(
	terminals: readonly Terminal[],
	focusedId: string | null,
): Terminal | null {
	const ready = terminals.filter(
		(terminal) =>
			terminal.endedAt === null &&
			(terminal.agent === "claude" || terminal.agent === "codex") &&
			typeof terminal.baselineObjectId === "string",
	);
	const focused = ready.find((terminal) => terminal.id === focusedId);
	if (focused) return focused;
	return [...ready].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
}
