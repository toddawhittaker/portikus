import { z } from "zod";
import { CodingAgent, TerminalId } from "./terminal.js";

/**
 * The chat socket between the workspace agent, the API relay and the
 * browser (SPEC.md §10.8). Nothing here names a particular agent's SDK, so
 * a second agent can produce the same events.
 */

/** Largest frame the browser may send; attachments travel as paths, so this is ample. */
export const MAX_CHAT_CLIENT_FRAME_BYTES = 1024 * 1024;
/** Largest frame the server may send: a 5 MiB image as base64 plus its envelope. */
export const MAX_CHAT_SERVER_FRAME_BYTES = 8 * 1024 * 1024;
/** Largest decoded image in a tool result. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/** Most files one `send` may attach. */
export const MAX_CHAT_ATTACHMENTS = 10;
/** Longest prompt text one `send` may carry. */
export const MAX_CHAT_TEXT_CHARS = 100_000;
export const MAX_CHAT_QUESTIONS = 4;
export const MIN_CHAT_QUESTION_OPTIONS = 2;
export const MAX_CHAT_QUESTION_OPTIONS = 4;
/** The model is asked for 12 characters but does not always obey. */
export const MAX_CHAT_QUESTION_HEADER_CHARS = 40;

/** The SDK's permission modes, less `dontAsk`, which the picker does not offer. */
export const ChatPermissionMode = z.enum([
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"bypassPermissions",
]);
export type ChatPermissionMode = z.infer<typeof ChatPermissionMode>;

export const ChatEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ChatEffort = z.infer<typeof ChatEffort>;

/** The effort a new chat starts at, for the host and the pickers alike. */
export const CHAT_START_EFFORT: ChatEffort = "high";

/** SVG is refused because it can carry script. */
export const ChatImageMediaType = z.enum([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
export type ChatImageMediaType = z.infer<typeof ChatImageMediaType>;

/** Decoded size of base64 data, without decoding it. */
export function decodedBase64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

const Base64Image = z
	.string()
	// A flat character class: a grouped pattern overflows the stack on megabytes.
	.regex(/^[A-Za-z0-9+/]*={0,2}$/, { message: "Not base64" })
	.refine((data) => data.length % 4 === 0, { message: "Not base64" })
	.refine((data) => decodedBase64Bytes(data) <= MAX_CHAT_IMAGE_BYTES, {
		message: "Image too large",
	});

/** A project-relative path: no leading slash and no `..` segment. */
const ProjectRelativePath = z
	.string()
	.min(1)
	.max(4096)
	.refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
		message: "Path must be project-relative",
	});

export const ChatAttachment = z.object({ path: ProjectRelativePath }).strict();
export type ChatAttachment = z.infer<typeof ChatAttachment>;

const Attachments = z.array(ChatAttachment).max(MAX_CHAT_ATTACHMENTS);

export const ChatMessage = z.object({
	id: z.string().min(1),
	role: z.enum(["user", "assistant"]),
	markdown: z.string(),
	attachments: Attachments.optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** One question, shaped like Claude's `AskUserQuestionInput`. */
export const ChatQuestion = z.object({
	question: z.string().min(1),
	header: z.string().max(MAX_CHAT_QUESTION_HEADER_CHARS),
	multiSelect: z.boolean(),
	options: z
		.array(
			z.object({
				label: z.string().min(1),
				description: z.string(),
				preview: z.string().optional(),
			}),
		)
		.min(MIN_CHAT_QUESTION_OPTIONS)
		.max(MAX_CHAT_QUESTION_OPTIONS),
});
export type ChatQuestion = z.infer<typeof ChatQuestion>;

const Questions = z.array(ChatQuestion).min(1).max(MAX_CHAT_QUESTIONS);

/** Longest permission rule the host reports or the browser may revoke. */
export const MAX_CHAT_RULE_CHARS = 4096;

/**
 * A rule the student granted with "Always allow" that lasts only for this
 * chat session, in Claude Code's rule syntax such as `Bash(sed:*)`, with a
 * plain-English description (SPEC.md §10.8).
 */
export const ChatSessionRule = z.object({
	rule: z.string().min(1).max(MAX_CHAT_RULE_CHARS),
	description: z.string(),
});
export type ChatSessionRule = z.infer<typeof ChatSessionRule>;

const PermissionCardFields = {
	id: z.string().min(1),
	toolName: z.string().min(1),
	title: z.string(),
	input: z.json(),
	options: z
		.array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
		.min(1),
};

const QuestionCardFields = {
	id: z.string().min(1),
	questions: Questions,
};

/** A card still waiting for an answer, as sent in a snapshot. */
export const ChatOpenCard = z.discriminatedUnion("type", [
	z.object({ type: z.literal("permission"), ...PermissionCardFields }),
	z.object({ type: z.literal("question"), ...QuestionCardFields }),
]);
export type ChatOpenCard = z.infer<typeof ChatOpenCard>;

export const ChatToolOutputPart = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({
		type: z.literal("image"),
		mediaType: ChatImageMediaType,
		data: Base64Image,
	}),
	/** A history image left out so the snapshot fits in one server frame. */
	z.object({ type: z.literal("imageOmitted"), mediaType: ChatImageMediaType }),
]);
export type ChatToolOutputPart = z.infer<typeof ChatToolOutputPart>;

/** The session is the terminal id, which is also the SDK session id. */
const Envelope = {
	sessionId: TerminalId,
	seq: z.number().int().nonnegative(),
};

export const ChatServerEvent = z.discriminatedUnion("type", [
	/**
	 * Sent first on every attach. It holds the open cards and whether a turn
	 * is running.
	 * History follows it as ordinary events, one frame each with rising
	 * `seq`: per turn `turn.started`, `message`, the `tool.*` events, then
	 * `turn.finished` (left out for a turn still running). At most the last
	 * 20 turns are replayed, and `truncated` says older turns exist. Tool
	 * images older than the last 5 turns, or too large for one frame, are
	 * replayed as `imageOmitted`. A reply streaming now follows as one
	 * `text.delta` holding its text so far, then live events, then
	 * `settings`.
	 */
	z.object({
		type: z.literal("snapshot"),
		...Envelope,
		cards: z.array(ChatOpenCard),
		turnRunning: z.boolean(),
		/** Turns older than the replayed ones exist. */
		truncated: z.boolean(),
	}),
	z.object({
		type: z.literal("turn.started"),
		...Envelope,
		/** Epoch milliseconds the turn started, from the transcript on replay. */
		at: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal("text.delta"),
		...Envelope,
		messageId: z.string().min(1),
		text: z.string(),
	}),
	z.object({ type: z.literal("message"), ...Envelope, ...ChatMessage.shape }),
	z.object({
		type: z.literal("tool.started"),
		...Envelope,
		id: z.string().min(1),
		name: z.string().min(1),
		title: z.string(),
		input: z.json(),
	}),
	z.object({
		type: z.literal("tool.output"),
		...Envelope,
		id: z.string().min(1),
		part: ChatToolOutputPart,
	}),
	z.object({
		type: z.literal("tool.finished"),
		...Envelope,
		id: z.string().min(1),
		isError: z.boolean(),
	}),
	z.object({
		type: z.literal("permission.requested"),
		...Envelope,
		...PermissionCardFields,
	}),
	z.object({
		type: z.literal("question.requested"),
		...Envelope,
		...QuestionCardFields,
	}),
	z.object({ type: z.literal("card.resolved"), ...Envelope, id: z.string().min(1) }),
	z.object({
		type: z.literal("turn.finished"),
		...Envelope,
		status: z.enum(["done", "interrupted", "error"]),
		/** Epoch milliseconds the turn finished, from the transcript on replay. */
		at: z.number().int().nonnegative(),
	}),
	z.object({ type: z.literal("error"), ...Envelope, message: z.string() }),
	z.object({
		type: z.literal("settings"),
		...Envelope,
		agent: CodingAgent,
		model: z.string().min(1),
		effort: ChatEffort,
		mode: ChatPermissionMode,
	}),
	/** Every session rule now in force; sent on attach and on each change. */
	z.object({
		type: z.literal("rules"),
		...Envelope,
		rules: z.array(ChatSessionRule),
	}),
]);
export type ChatServerEvent = z.infer<typeof ChatServerEvent>;

/** Answers and notes are keyed by the question text, as Claude expects. */
const AnswerMap = z.record(z.string(), z.string());

export const ChatClientMessage = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("send"),
			text: z.string().max(MAX_CHAT_TEXT_CHARS),
			attachments: Attachments,
		})
		.strict(),
	z
		.object({
			type: z.literal("permission.answer"),
			id: z.string().min(1),
			optionId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			type: z.literal("question.answer"),
			id: z.string().min(1),
			answers: AnswerMap,
			notes: AnswerMap.optional(),
		})
		.strict(),
	z.object({ type: z.literal("interrupt") }).strict(),
	z
		.object({
			type: z.literal("rule.revoke"),
			rule: z.string().min(1).max(MAX_CHAT_RULE_CHARS),
		})
		.strict(),
	z
		.object({
			type: z.literal("set"),
			model: z.string().min(1).optional(),
			effort: ChatEffort.optional(),
			mode: ChatPermissionMode.optional(),
		})
		.strict(),
]);
export type ChatClientMessage = z.infer<typeof ChatClientMessage>;
