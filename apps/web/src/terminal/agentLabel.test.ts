import { expect, test } from "vitest";
import { agentLabel } from "./agentLabel";

test("each agent's chat and terminal are told apart as the New tab menu names them, a shell has none", () => {
	expect(agentLabel({ agent: "claude", kind: "chat" })).toBe("Claude Code (GUI)");
	expect(agentLabel({ agent: "claude", kind: "terminal" })).toBe("Claude Code (TUI)");
	expect(agentLabel({ agent: "codex", kind: "chat" })).toBe("Codex (GUI)");
	expect(agentLabel({ agent: "codex", kind: "terminal" })).toBe("Codex (TUI)");
	expect(agentLabel({ agent: null, kind: "terminal" })).toBeNull();
});
