import type { Terminal } from "@portikus/contracts";

/**
 * The name a coding agent's tab and pane share, or null for a plain shell,
 * which keeps its own name. Claude Code's chat and terminal tabs are told
 * apart by the same words the New tab menu uses (SPEC.md §10.8).
 */
export function agentLabel(terminal: Pick<Terminal, "agent" | "kind">): string | null {
	if (terminal.agent === "codex") return "Codex";
	if (terminal.agent !== "claude") return null;
	return terminal.kind === "chat" ? "Claude Code (GUI)" : "Claude Code (TUI)";
}
