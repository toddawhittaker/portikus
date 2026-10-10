import type { CodingAgentTool, ImageDiff } from "@portikus/contracts";

export const CODING_AGENT_NAME: Record<CodingAgentTool, string> = {
	claude: "Claude Code",
	codex: "Codex",
};

/** What an image without its own claude or codex runs instead. */
const SHARED_FOLDER = "Shared folder";

function isAgent(name: string): boolean {
	return name === "claude" || name === "codex";
}

/**
 * An image's manifest has no claude or codex version when the tools come from
 * the shared folder (SPEC.md section 22.4), so the diff says "Shared folder"
 * rather than that the tool was added or removed.
 */
export function sharedFolderTools(part: ImageDiff["tools"]): ImageDiff["tools"] {
	return {
		added: part.added.filter((a) => !isAgent(a.name)),
		removed: part.removed.filter((r) => !isAgent(r.name)),
		changed: [
			...part.changed.map((c) =>
				isAgent(c.name)
					? { name: c.name, from: c.from ?? SHARED_FOLDER, to: c.to ?? SHARED_FOLDER }
					: c,
			),
			...part.removed
				.filter((r) => isAgent(r.name))
				.map((r) => ({ name: r.name, from: r.version, to: SHARED_FOLDER })),
			...part.added
				.filter((a) => isAgent(a.name))
				.map((a) => ({ name: a.name, from: SHARED_FOLDER, to: a.version })),
		],
	};
}
