import { expect, test } from "vitest";
import { sharedFolderTools } from "./codingAgents.js";

test("claude and codex without a version read as the shared folder, not as added or removed", () => {
	expect(
		sharedFolderTools({
			added: [
				{ name: "codex", version: "codex-cli 0.40.0" },
				{ name: "uv", version: "0.8" },
			],
			removed: [
				{ name: "claude", version: "2.0.1 (Claude Code)" },
				{ name: "npm", version: "11" },
			],
			changed: [{ name: "node", from: "v24.8.0", to: "v24.9.0" }],
		}),
	).toEqual({
		added: [{ name: "uv", version: "0.8" }],
		removed: [{ name: "npm", version: "11" }],
		changed: [
			{ name: "node", from: "v24.8.0", to: "v24.9.0" },
			{ name: "claude", from: "2.0.1 (Claude Code)", to: "Shared folder" },
			{ name: "codex", from: "Shared folder", to: "codex-cli 0.40.0" },
		],
	});
});
