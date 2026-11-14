import { z } from "zod";

/**
 * Starting fresh with a handoff note (SPEC.md §10.8): the agent writes a
 * note as its reply, the workspace agent saves it under `.portikus/handoffs/`,
 * and the new conversation's first message carries it. The host and the
 * browser both read these, so they live here.
 */

/** The slash command that starts a handoff, typed as `/handoff`. */
export const HANDOFF_COMMAND = "handoff";

/** Where the notes are saved, relative to the project. */
export const HANDOFF_NOTES_DIR = ".portikus/handoffs";

/** Longest note kept; the prompt asks for about 1,500 words, far less. */
export const MAX_HANDOFF_NOTE_CHARS = 60_000;

/** A saved note's path: one file the host named, never one a browser chose. */
export const HandoffNotePath = z
	.string()
	.regex(
		/^\.portikus\/handoffs\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z(-[0-9]+)?\.md$/,
	);

export const HandoffNoteText = z.string().max(MAX_HANDOFF_NOTE_CHARS);

/**
 * What a fresh chat adds by reading a handoff note, in tokens. The
 * fresh-chat estimate and the automatic handoff's size test both use it.
 */
export const HANDOFF_TOKENS = 8000;

/** The fixed request for the note, sent as a message Portikus writes for the student. */
export const HANDOFF_PROMPT = `Write a handoff note so that a fresh conversation can pick up this work. Reply with the note only, in Markdown, in about 1,500 words at most. Use these level-2 headings, in this order:

## Goal
## Current state
## Decisions and why
## Files involved
## Tried and failed
## Open questions
## Next steps
## How to check the work

Do not run tools or write files for this. Portikus saves your reply as the note.`;

/** A saved note waiting for the student to continue, edit or cancel. */
export const HandoffReview = z.object({
	id: z.uuid(),
	path: HandoffNotePath,
	markdown: HandoffNoteText,
});
export type HandoffReview = z.infer<typeof HandoffReview>;

/**
 * A note the host wrote on its own while the student was away, before the
 * prompt cache went cold (SPEC.md §10.8). The chat shows it as a notice.
 */
export const HandoffNotice = z.object({
	id: z.uuid(),
	path: HandoffNotePath,
	markdown: HandoffNoteText,
});
export type HandoffNotice = z.infer<typeof HandoffNotice>;

/** The last line of the new conversation's first message. */
export const HANDOFF_CONTINUE_LINE =
	"Continue from Next steps. Before acting, say in three lines what you understand the task to be.";

const SAVED_AT = "This handoff note is saved at ";

/** The new conversation's first message: the note, its path, then what to do. */
export function handoffFirstMessage(path: string, note: string): string {
	return `${note.trim()}\n\n${SAVED_AT}${path}.\n\n${HANDOFF_CONTINUE_LINE}`;
}

/** Whether a student message is the one Portikus sent from a handoff, so the chat can say so. */
export function isHandoffFirstMessage(text: string): boolean {
	if (!text.endsWith(HANDOFF_CONTINUE_LINE)) return false;
	const lines = text.slice(0, -HANDOFF_CONTINUE_LINE.length).trimEnd().split("\n");
	const saved = lines.at(-1) ?? "";
	return (
		saved.startsWith(SAVED_AT) &&
		HandoffNotePath.safeParse(saved.slice(SAVED_AT.length, -1)).success
	);
}
