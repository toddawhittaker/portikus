import { Icon } from "@portikus/ui";
import { DIR_TITLE, type GitDecoration, type GitDecorationKind } from "./gitStatus.js";

/*
 * The marks are hidden from screen readers because each row already says the
 * same words in its own text (SPEC.md §25.8); the title is for the pointer.
 * The colour comes from files.css by kind, and the letter or shape always says
 * the kind too, so colour is never the only cue.
 */

/** The coloured letter at a changed path, in the tree and the Changes list. */
export function GitLetter({ decoration }: { decoration: GitDecoration }) {
	return (
		<span
			className="pk-git-letter"
			data-kind={decoration.kind}
			title={decoration.title}
			aria-hidden="true"
		>
			{decoration.letter}
		</span>
	);
}

/**
 * The mark on a folder with changes below it, coloured by the most important
 * one. A conflict draws the alert shape, so it reads without colour too.
 */
export function GitDot({ kind }: { kind: GitDecorationKind }) {
	return (
		<span
			className="pk-git-dot"
			data-kind={kind}
			title={DIR_TITLE[kind]}
			aria-hidden="true"
		>
			{kind === "conflict" ? <Icon name="alert" size="sm" /> : null}
		</span>
	);
}
