import type { Terminal } from "@portikus/contracts";
import { agentTabName } from "../agents/codingAgentName.js";

/**
 * The name a coding agent's tab and pane share, or null for a plain shell,
 * which keeps its own name. Each agent's chat and terminal tabs are told
 * apart by the same words the New tab menu uses (SPEC.md §10.8).
 */
export function agentLabel(terminal: Pick<Terminal, "agent" | "kind">): string | null {
	if (terminal.agent !== "claude" && terminal.agent !== "codex") return null;
	return agentTabName(terminal.agent, terminal.kind);
}
