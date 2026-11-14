import type { CodingAgentTool, TerminalKind } from "@portikus/contracts";

export const CODING_AGENT_NAME: Record<CodingAgentTool, string> = {
	claude: "Claude Code",
	codex: "Codex",
};

/**
 * An agent's tab as the New tab menu offers it: "Claude Code (GUI)" for its
 * chat, "Codex (TUI)" for its terminal (SPEC.md §10.2, §10.8).
 */
export function agentTabName(agent: CodingAgentTool, kind: TerminalKind): string {
	return `${CODING_AGENT_NAME[agent]} (${kind === "chat" ? "GUI" : "TUI"})`;
}
