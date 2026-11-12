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
/** Longest deny reason or "keep planning" text a permission answer may carry. */
const MAX_CHAT_ANSWER_MESSAGE_CHARS = 2000;
/** Longest conversation title shown for a chat tab. */
export const MAX_AGENT_TITLE_CHARS = 80;
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

/**
 * A model as Claude Code names it: a short name such as `opus`, which means
 * the newest version, or a full ID such as `claude-opus-4-8`, which pins one.
 * The characters allowed include the brackets of a suffix like `[1m]`.
 */
export const ChatModel = z
	.string()
	.max(100)
	.regex(/^[a-z0-9][a-z0-9.\-[\]]*$/);
export type ChatModel = z.infer<typeof ChatModel>;

/** What a chat starts at when the project has no last-used settings (SPEC.md §10.8). */
export const CHAT_START_SETTINGS: {
	model: ChatModel;
	effort: ChatEffort;
	mode: ChatPermissionMode;
} = { model: "opus", effort: "medium", mode: "auto" };

/** Most models one `models` event lists. */
export const MAX_CHAT_MODELS = 50;

/** One model Claude Code offers the account, as `supportedModels()` lists it. */
export const ChatModelInfo = z.object({
	value: ChatModel,
	/** The full ID the value means today; a short name's current version. */
	resolvedModel: z.string().max(100).optional(),
	displayName: z.string().max(100),
	description: z.string().max(300),
	supportsAutoMode: z.boolean(),
});
export type ChatModelInfo = z.infer<typeof ChatModelInfo>;

/**
 * The permission mode a new chat starts at on this model: Auto, or Ask when
 * the model says it does not support Auto (SPEC.md §10.8).
 */
export function chatStartMode(
	models: readonly ChatModelInfo[],
	model: string,
): ChatPermissionMode {
	const unsupported =
		models.find((row) => row.value === model)?.supportsAutoMode === false;
	return unsupported ? "default" : CHAT_START_SETTINGS.mode;
}

/**
 * The picker values a student last used in one project, which a new chat
 * there starts with (SPEC.md §10.8). Only these values, never content.
 */
export const ChatLastSettings = z
	.object({
		model: ChatModel,
		effort: ChatEffort,
		mode: ChatPermissionMode,
		/** Read each reply aloud; optional so a client from before it still saves. */
		readAloud: z.boolean().optional(),
	})
	.strict();
export type ChatLastSettings = z.infer<typeof ChatLastSettings>;

/**
 * A stored value read back: a missing or unreadable one becomes the value a
 * new chat starts with, and Bypass permissions is never carried into a new
 * chat, so it comes back as Auto (SPEC.md §10.8).
 */
export const StoredChatSettings = z
	.object({
		model: ChatModel.catch(CHAT_START_SETTINGS.model),
		effort: ChatEffort.catch(CHAT_START_SETTINGS.effort),
		mode: ChatPermissionMode.catch(CHAT_START_SETTINGS.mode),
		readAloud: z.boolean().catch(false),
	})
	.transform((value) => ({
		...value,
		mode: value.mode === "bypassPermissions" ? ("auto" as const) : value.mode,
	}));

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

/** One slash command the chat offers, as the host lists it. */
export const ChatCommand = z.object({
	/** The name without its leading slash. */
	name: z
		.string()
		.min(1)
		.max(64)
		.refine((name) => !name.startsWith("/"), { message: "No leading slash" }),
	description: z.string().max(200),
	argumentHint: z.string().max(100).optional(),
	/** Only the terminal Claude Code can run it; the chat shows it as unavailable. */
	terminalOnly: z.boolean(),
});
export type ChatCommand = z.infer<typeof ChatCommand>;

/** Most slash commands one `commands` event lists. */
export const MAX_CHAT_COMMANDS = 200;

/** Longest command, and most output, a `!` shell command item keeps. */
export const MAX_CHAT_SHELL_COMMAND_CHARS = 4000;
export const MAX_CHAT_SHELL_OUTPUT_CHARS = 65_536;

const ShellCommandFields = {
	id: z.string().min(1),
	command: z.string().max(MAX_CHAT_SHELL_COMMAND_CHARS),
	output: z.string().max(MAX_CHAT_SHELL_OUTPUT_CHARS),
	/** Null while it runs, or when it was stopped without an exit code. */
	exitCode: z.number().int().nullable(),
	/** The output hit the cap and the rest was dropped. */
	truncated: z.boolean(),
	state: z.enum(["running", "done"]),
};

/** A `!` shell command and its output as a chat item. */
export const ChatShellItem = z.object({
	kind: z.literal("shell"),
	...ShellCommandFields,
});
export type ChatShellItem = z.infer<typeof ChatShellItem>;

/** The session is the terminal id, which is also the SDK session id. */
const Envelope = {
	sessionId: TerminalId,
	seq: z.number().int().nonnegative(),
};

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
const SnapshotEvent = z.object({
	type: z.literal("snapshot"),
	...Envelope,
	cards: z.array(ChatOpenCard),
	turnRunning: z.boolean(),
	/** Turns older than the replayed ones exist. */
	truncated: z.boolean(),
});
const TurnStartedEvent = z.object({
	type: z.literal("turn.started"),
	...Envelope,
	/** Epoch milliseconds the turn started, from the transcript on replay. */
	at: z.number().int().nonnegative(),
});
const TextDeltaEvent = z.object({
	type: z.literal("text.delta"),
	...Envelope,
	messageId: z.string().min(1),
	text: z.string(),
});
const MessageEvent = z.object({
	type: z.literal("message"),
	...Envelope,
	...ChatMessage.shape,
});
const ToolStartedEvent = z.object({
	type: z.literal("tool.started"),
	...Envelope,
	id: z.string().min(1),
	name: z.string().min(1),
	title: z.string(),
	input: z.json(),
});
const ToolOutputEvent = z.object({
	type: z.literal("tool.output"),
	...Envelope,
	id: z.string().min(1),
	part: ChatToolOutputPart,
});
const ToolFinishedEvent = z.object({
	type: z.literal("tool.finished"),
	...Envelope,
	id: z.string().min(1),
	isError: z.boolean(),
});
const TurnFinishedEvent = z.object({
	type: z.literal("turn.finished"),
	...Envelope,
	status: z.enum(["done", "interrupted", "error"]),
	/** Epoch milliseconds the turn finished, from the transcript on replay. */
	at: z.number().int().nonnegative(),
});

/** Longest reason a rename failed. */
export const MAX_CHAT_RENAME_MESSAGE_CHARS = 200;

/** Longest Agent tool call id a watch may name. */
export const MAX_CHAT_TOOL_ID_CHARS = 200;
const ToolUseId = z.string().min(1).max(MAX_CHAT_TOOL_ID_CHARS);

/**
 * One event of a subagent's own conversation, numbered on a sequence of its
 * own that starts at each watch with a snapshot (no cards; `turnRunning`
 * while the subagent runs). Its whole run is one turn, which a
 * `turn.finished` ends.
 */
export const ChatSubagentEvent = z.discriminatedUnion("type", [
	SnapshotEvent,
	TurnStartedEvent,
	TextDeltaEvent,
	MessageEvent,
	ToolStartedEvent,
	ToolOutputEvent,
	ToolFinishedEvent,
	TurnFinishedEvent,
]);
export type ChatSubagentEvent = z.infer<typeof ChatSubagentEvent>;

export const ChatServerEvent = z.discriminatedUnion("type", [
	SnapshotEvent,
	TurnStartedEvent,
	TextDeltaEvent,
	MessageEvent,
	ToolStartedEvent,
	ToolOutputEvent,
	ToolFinishedEvent,
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
	TurnFinishedEvent,
	/**
	 * A subagent's conversation, sent only to an attachment watching that
	 * Agent tool call. It carries no `seq` of the chat's own: the watch
	 * numbers its events itself, so watching never leaves a gap in another
	 * attachment's sequence.
	 */
	z.object({
		type: z.literal("subagent"),
		sessionId: TerminalId,
		toolUseId: ToolUseId,
		event: ChatSubagentEvent,
	}),
	z.object({ type: z.literal("error"), ...Envelope, message: z.string() }),
	/**
	 * The answer to a `rename`, sent only to the attachment that asked. Like a
	 * subagent frame it carries no `seq`, so other attachments see no gap.
	 */
	z.object({
		type: z.literal("rename.result"),
		ok: z.boolean(),
		message: z.string().max(MAX_CHAT_RENAME_MESSAGE_CHARS).optional(),
	}),
	z.object({
		type: z.literal("settings"),
		...Envelope,
		agent: CodingAgent,
		model: z.string().min(1),
		effort: ChatEffort,
		mode: ChatPermissionMode,
	}),
	/** The slash commands on offer; sent on attach and when the list changes. */
	z.object({
		type: z.literal("commands"),
		...Envelope,
		commands: z.array(ChatCommand).max(MAX_CHAT_COMMANDS),
	}),
	/**
	 * How full the context is and when the prompt cache goes cold; sent after
	 * each main-thread assistant message and on attach. `windowTokens` is null
	 * when the model's window is unknown.
	 */
	z.object({
		type: z.literal("context"),
		...Envelope,
		usedTokens: z.number().int().nonnegative(),
		windowTokens: z.number().int().positive().nullable(),
		cache: z
			.object({
				/** Epoch milliseconds the cache was last written or read. */
				at: z.number().int().nonnegative(),
				ttlSeconds: z.union([z.literal(300), z.literal(3600)]),
			})
			.nullable(),
		/** The host's clock, epoch milliseconds, when it sent this; older hosts leave it out. */
		now: z.number().int().nonnegative().optional(),
	}),
	/** A `!` shell command: sent when it starts and again, same id, when it ends. */
	z.object({ type: z.literal("shell"), ...Envelope, ...ShellCommandFields }),
	/**
	 * The models Claude Code offers this account; sent on attach, before the
	 * settings, once the host has read them.
	 */
	z.object({
		type: z.literal("models"),
		...Envelope,
		models: z.array(ChatModelInfo).max(MAX_CHAT_MODELS),
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
			/** Why the student denied, or what to plan instead; sent only when typed. */
			message: z.string().min(1).max(MAX_CHAT_ANSWER_MESSAGE_CHARS).optional(),
			/** Ignored: the host derives a plan's mode from optionId. Kept so older browsers still parse. */
			mode: z.enum(["acceptEdits", "default"]).optional(),
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
			model: ChatModel.optional(),
			effort: ChatEffort.optional(),
			mode: ChatPermissionMode.optional(),
		})
		.strict(),
	/**
	 * Watch the subagent an Agent tool call started, read-only. One watch per
	 * attachment: a new one replaces the last.
	 */
	z.object({ type: z.literal("subagent.watch"), toolUseId: ToolUseId }).strict(),
	z.object({ type: z.literal("subagent.unwatch"), toolUseId: ToolUseId }).strict(),
	/** Retitle the conversation; the host cleans the title (ADR 0074). */
	z
		.object({
			type: z.literal("rename"),
			title: z.string().min(1).max(MAX_AGENT_TITLE_CHARS),
		})
		.strict(),
]);
export type ChatClientMessage = z.infer<typeof ChatClientMessage>;

/**
 * A message that starts with `!` is a shell command, not a prompt (SPEC.md
 * §10.8). A lone `!` is not one: there is nothing to run. The composer and
 * the chat host share this rule.
 */
export function shellCommandText(text: string): string {
	const trimmed = text.trimStart();
	return (trimmed.startsWith("!") ? trimmed.slice(1) : trimmed).trim();
}

export function isShellCommand(text: string): boolean {
	return text.trimStart().startsWith("!") && shellCommandText(text) !== "";
}
