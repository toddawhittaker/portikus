import { Badge, type BadgeTone } from "@portikus/ui";
import type { GitDecorationKind } from "./gitStatus.js";

// A conflict keeps its own hue through files.css (SPEC.md §12.8).
const TONE: Record<GitDecorationKind, BadgeTone> = {
	added: "success",
	untracked: "success",
	modified: "warning",
	deleted: "danger",
	renamed: "info",
	conflict: "danger",
};

/** The letter badge at a changed path: the same badge as every other status. */
export function GitLetter({
	kind,
	letter,
}: {
	kind: GitDecorationKind;
	letter: string;
}) {
	return (
		<Badge tone={TONE[kind]} className="pk-git-letter" aria-hidden="true">
			{letter}
		</Badge>
	);
}
