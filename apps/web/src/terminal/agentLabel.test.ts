import { expect, test } from "vitest";
import { agentLabel } from "./agentLabel";

test("Claude Code's chat and terminal are told apart, Codex is Codex, a shell has none", () => {
	expect(agentLabel({ agent: "claude", kind: "chat" })).toBe("Claude Code (GUI)");
	expect(agentLabel({ agent: "claude", kind: "terminal" })).toBe("Claude Code (TUI)");
	expect(agentLabel({ agent: "codex", kind: "terminal" })).toBe("Codex");
	expect(agentLabel({ agent: null, kind: "terminal" })).toBeNull();
});
