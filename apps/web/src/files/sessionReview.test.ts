/**
 * Which terminal still offers Review session changes (SPEC.md §10.9).
 */
import type { Terminal } from "@portikus/contracts";
import { expect, test } from "vitest";
import { openAgentSession } from "./sessionReview.js";

const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function terminal(partial: Partial<Terminal> & Pick<Terminal, "id">): Terminal {
	return {
		workspaceId: "22222222-2222-4222-8222-222222222222",
		name: "Terminal 1",
		cwd: "/home/student/projects/todo-api",
		position: 0,
		projectId: "33333333-3333-4333-8333-333333333333",
		createdAt: "2026-01-01T00:00:00.000Z",
		theme: "dark",
		endedAt: null,
		agent: "claude",
		baselineObjectId: BASE,
		...partial,
	};
}

test("an ended agent terminal with a baseline still offers session review", () => {
	const ended = terminal({
		id: "44444444-4444-4444-8444-444444444444",
		endedAt: "2026-01-02T00:00:00.000Z",
	});
	expect(openAgentSession([ended], null)?.id).toBe(ended.id);
});

test("a terminal with no baseline is not a session to review", () => {
	const plain = terminal({
		id: "44444444-4444-4444-8444-444444444444",
		baselineObjectId: null,
	});
	expect(openAgentSession([plain], null)).toBeNull();
});
