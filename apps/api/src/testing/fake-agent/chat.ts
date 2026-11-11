import type { WebSocket } from "@fastify/websocket";
import {
	type ChatClientMessage,
	type ChatCommand,
	type ChatEffort,
	type ChatMessage,
	type ChatModelInfo,
	type ChatOpenCard,
	type ChatPermissionMode,
	ChatServerEvent,
	isShellCommand,
	MAX_ATTACHMENTS_PER_TERMINAL,
	shellCommandText,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { setCodingAgentTitle } from "./coding-agents.js";
import type { FakeAgentState } from "./state.js";

/** A 1 by 1 pixel PNG, small enough to sit inside a frame. */
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FINAL_MARKDOWN = [
	"Here is the **plan**.",
	"",
	"```ts",
	"export const answer = 42;",
	"```",
	"",
	"See [the docs](https://example.com/docs).",
	"",
	"![remote pixel](https://example.com/pixel.png)",
].join("\n");

const QUESTION_CARD: Extract<ChatOpenCard, { type: "question" }> = {
	type: "question",
	id: "card-question",
	questions: [
		{
			question: "Which checks should run?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "Style rules" },
				{ label: "Tests", description: "Unit tests" },
				{ label: "Types", description: "Type checking" },
			],
		},
		{
			question: "Which layout?",
			header: "Layout",
			multiSelect: false,
			options: [
				{ label: "Tabs", description: "One tab per file", preview: "+----+----+" },
				{ label: "Tree", description: "A folder tree", preview: "|- src\n|- test" },
			],
		},
	],
};

const PERMISSION_CARD: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "card-permission",
	toolName: "Bash",
	title: "Run npm test",
	input: { command: "npm test" },
	options: [
		{ id: "allow", label: "Allow" },
		{ id: "deny", label: "Deny" },
	],
};

/** When the fake's earlier turn began, in epoch milliseconds. */
const EARLIER_TURN_AT = Date.UTC(2026, 0, 1, 12, 0, 0);

/** The command list a fake chat starts with; a test can replace it. */
const DEFAULT_COMMANDS: ChatCommand[] = [
	{
		name: "compact",
		description: "Free up context by summarizing the chat",
		terminalOnly: false,
	},
	{
		name: "review",
		description: "Review a pull request",
		argumentHint: "<pull request>",
		terminalOnly: false,
	},
	{ name: "config", description: "Open the settings menu", terminalOnly: true },
];

/** The models a fake chat offers, shaped like Claude Code's own list. */
const row = (
	value: string,
	displayName: string,
	description: string,
	resolvedModel = value,
	supportsAutoMode = true,
): ChatModelInfo => ({
	value,
	resolvedModel,
	displayName,
	description,
	supportsAutoMode,
});

const DEFAULT_MODELS: ChatModelInfo[] = [
	row(
		"default",
		"Default (recommended)",
		"Opus 5.5 · Best for everyday, complex tasks",
		"claude-opus-5-5",
	),
	row("opus", "Opus 5.5", "For complex work and everyday tasks", "claude-opus-5-5"),
	row("fable", "Fable 5.2", "For your toughest challenges", "claude-fable-5-2"),
	row("sonnet", "Sonnet 5.5", "Most efficient for simpler tasks", "claude-sonnet-5-5"),
	row("haiku", "Haiku 5.5", "Fastest for quick answers", "claude-haiku-5-5"),
	row("claude-fable-5-1", "Fable 5.1", "Most capable for your hardest tasks"),
	row(
		"claude-haiku-4-5-20251001",
		"Haiku 4.5",
		"Fastest for quick answers",
		undefined,
		false,
	),
	row("claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
	row("claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks"),
	row("claude-opus-4-7", "Opus 4.7", "Best for everyday, complex tasks"),
	row("claude-sonnet-4-6", "Sonnet 4.6", "Efficient for routine tasks"),
];

/** What a test reads back: one answer, as the browser sent it. */
type FakeChatAnswer = Extract<
	ChatClientMessage,
	{ type: "permission.answer" | "question.answer" }
>;

interface FakeChat {
	seq: number;
	started: boolean;
	/** Finished history, replayed to each later attachment as events (SPEC.md §9.7). */
	history: Record<string, unknown>[];
	openCards: ChatOpenCard[];
	answers: FakeChatAnswer[];
	received: string[];
	settings: { model: string; effort: ChatEffort; mode: ChatPermissionMode };
	commands: ChatCommand[];
	/** The models on offer; sent on attach, before the settings. */
	models: ChatModelInfo[];
	/** The last `context` event body a test set; sent on attach. */
	context: Record<string, unknown> | null;
	sockets: Set<WebSocket>;
}

/**
 * The agent's chat socket, scripted (SPEC.md §9.7). The first `send`
 * starts one fixed turn; every attachment gets a snapshot with the cards
 * still open, the finished history as events, then the settings. Every frame is checked against the contract before it
 * is sent.
 */
export function registerChatRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { terminals } = s;
	const chats = new Map<string, FakeChat>();

	function chatOf(id: string): FakeChat {
		let chat = chats.get(id);
		if (!chat) {
			chat = {
				seq: 0,
				started: false,
				history: [
					{ type: "turn.started", at: EARLIER_TURN_AT },
					{
						type: "message",
						id: "m-old-user",
						role: "user",
						markdown: "Earlier question",
					},
					{
						type: "message",
						id: "m-old-assistant",
						role: "assistant",
						markdown: "Earlier answer",
					},
					{ type: "turn.finished", at: EARLIER_TURN_AT + 4000, status: "done" },
				],
				openCards: [],
				answers: [],
				received: [],
				settings: { model: "sonnet", effort: "medium", mode: "default" },
				commands: DEFAULT_COMMANDS,
				models: DEFAULT_MODELS,
				context: null,
				sockets: new Set(),
			};
			chats.set(id, chat);
		}
		return chat;
	}

	/** Build an event, check it against the contract, and send it to the given sockets. */
	function emit(
		id: string,
		to: Iterable<WebSocket>,
		event: Record<string, unknown>,
	): void {
		const chat = chatOf(id);
		chat.seq += 1;
		const frame = JSON.stringify(
			ChatServerEvent.parse({ ...event, sessionId: id, seq: chat.seq }),
		);
		for (const peer of to) {
			if (peer.readyState === peer.OPEN) peer.send(frame);
		}
	}

	/** Send an event to the sockets and keep it for later attachments. */
	function record(
		id: string,
		to: Iterable<WebSocket>,
		event: Record<string, unknown>,
	): void {
		chatOf(id).history.push(event);
		emit(id, to, event);
	}

	function runScriptedTurn(id: string): void {
		const chat = chatOf(id);
		const all = chat.sockets;
		for (const text of ["Looking ", "at the ", "project."]) {
			emit(id, all, { type: "text.delta", messageId: "m-turn", text });
		}
		const final: ChatMessage = {
			id: "m-turn",
			role: "assistant",
			markdown: FINAL_MARKDOWN,
		};
		record(id, all, { type: "message", ...final });
		record(id, all, {
			type: "tool.started",
			id: "tool-1",
			name: "Read",
			title: "Read README.md",
			input: { file_path: "README.md" },
		});
		record(id, all, {
			type: "tool.output",
			id: "tool-1",
			part: { type: "text", text: "# README" },
		});
		record(id, all, {
			type: "tool.output",
			id: "tool-1",
			part: { type: "image", mediaType: "image/png", data: TINY_PNG },
		});
		record(id, all, { type: "tool.finished", id: "tool-1", isError: false });
		// The question card's tool call, which the conversation shows as "Asked 2 questions".
		record(id, all, {
			type: "tool.started",
			id: QUESTION_CARD.id,
			name: "AskUserQuestion",
			title: "AskUserQuestion",
			input: { questions: QUESTION_CARD.questions },
		});
		chat.openCards.push(QUESTION_CARD, PERMISSION_CARD);
		emit(id, all, { type: "question.requested", ...withoutType(QUESTION_CARD) });
		emit(id, all, { type: "permission.requested", ...withoutType(PERMISSION_CARD) });
		record(id, all, { type: "turn.finished", at: Date.now(), status: "done" });
	}

	function answer(id: string, message: FakeChatAnswer): void {
		const chat = chatOf(id);
		const card = chat.openCards.find((one) => one.id === message.id);
		// The first answer wins; a late one is dropped.
		if (!card) return;
		chat.openCards = chat.openCards.filter((one) => one.id !== message.id);
		chat.answers.push(message);
		emit(id, chat.sockets, { type: "card.resolved", id: message.id });
		if (message.type === "question.answer") {
			record(id, chat.sockets, {
				type: "tool.output",
				id: message.id,
				part: { type: "text", text: questionResultText(message.answers) },
			});
			record(id, chat.sockets, {
				type: "tool.finished",
				id: message.id,
				isError: false,
			});
		}
	}

	function handle(id: string, key: string, message: ChatClientMessage): void {
		const chat = chatOf(id);
		switch (message.type) {
			case "send": {
				// Claude Code's /rename retitles the session; the host reads it back after the result.
				const renamed = /^\/rename\s+(.+)$/s.exec(message.text.trim());
				if (renamed?.[1]) {
					record(id, chat.sockets, { type: "turn.started", at: Date.now() });
					record(id, chat.sockets, {
						type: "message",
						id: `m-user-${chat.seq}`,
						role: "user",
						markdown: message.text,
					});
					record(id, chat.sockets, {
						type: "message",
						id: `m-reply-${chat.seq}`,
						role: "assistant",
						markdown: `Session renamed to: ${renamed[1]}`,
					});
					record(id, chat.sockets, {
						type: "turn.finished",
						at: Date.now(),
						status: "done",
					});
					setCodingAgentTitle(s, key, id, renamed[1]);
					return;
				}
				// Claude Code's /clear starts a new session; the host sends a fresh snapshot.
				if (message.text.trim() === "/clear") {
					chat.history = [];
					emit(id, chat.sockets, {
						type: "snapshot",
						cards: chat.openCards,
						turnRunning: false,
						truncated: false,
					});
					emit(id, chat.sockets, {
						type: "settings",
						agent: "claude",
						...chat.settings,
					});
					return;
				}
				// A `!` command runs on the host with no turn; this one "prints" its own text.
				if (isShellCommand(message.text)) {
					const shell = {
						type: "shell",
						id: `sh-${chat.seq}`,
						command: shellCommandText(message.text),
						exitCode: null,
						truncated: false,
					};
					emit(id, chat.sockets, { ...shell, output: "", state: "running" });
					record(id, chat.sockets, {
						...shell,
						output: `ran ${shell.command}\n`,
						exitCode: 0,
						state: "done",
					});
					return;
				}
				const user: ChatMessage = {
					id: `m-user-${chat.seq}`,
					role: "user",
					markdown: message.text,
				};
				const first = !chat.started;
				chat.started = true;
				record(id, chat.sockets, { type: "turn.started", at: Date.now() });
				record(id, chat.sockets, { type: "message", ...user });
				if (first) {
					runScriptedTurn(id);
					return;
				}
				record(id, chat.sockets, {
					type: "message",
					id: `m-reply-${chat.seq}`,
					role: "assistant",
					markdown: "This is a canned reply.",
				});
				record(id, chat.sockets, {
					type: "turn.finished",
					at: Date.now(),
					status: "done",
				});
				return;
			}
			case "permission.answer":
			case "question.answer":
				answer(id, message);
				return;
			case "set":
				chat.settings = {
					model: message.model ?? chat.settings.model,
					effort: message.effort ?? chat.settings.effort,
					mode: message.mode ?? chat.settings.mode,
				};
				emit(id, chat.sockets, { type: "settings", agent: "claude", ...chat.settings });
				return;
			case "rename":
				setCodingAgentTitle(s, key, id, message.title);
				return;
			case "interrupt":
				record(id, chat.sockets, {
					type: "turn.finished",
					at: Date.now(),
					status: "interrupted",
				});
				return;
		}
	}

	app.get(
		"/terminals/:id/chat",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const id = (request.params as { id: string }).id;
			if (!terminals.has(id)) {
				socket.close(4404, "no such terminal");
				return;
			}
			const chat = chatOf(id);
			if (chat.sockets.size >= MAX_ATTACHMENTS_PER_TERMINAL) {
				socket.close(1008, "ATTACHMENT_LIMIT");
				return;
			}
			chat.sockets.add(socket);
			socket.on("close", () => chat.sockets.delete(socket));
			socket.on("message", (data: Buffer) => {
				const text = data.toString();
				chat.received.push(text);
				try {
					handle(id, s.keyOf(request), JSON.parse(text) as ChatClientMessage);
				} catch {
					// A frame the script cannot read is ignored, like an unknown type.
				}
			});
			emit(id, [socket], {
				type: "snapshot",
				cards: chat.openCards,
				turnRunning: false,
				truncated: false,
			});
			for (const event of chat.history) emit(id, [socket], event);
			// Before the settings, which tests wait for as the end of an attach.
			emit(id, [socket], { type: "commands", commands: chat.commands });
			emit(id, [socket], { type: "models", models: chat.models });
			if (chat.context) emit(id, [socket], { ...chat.context, type: "context" });
			emit(id, [socket], { type: "settings", agent: "claude", ...chat.settings });
		},
	);

	// Replace the slash command list and send it to every attachment, as the host does.
	app.post("/__test/chats/:id/commands", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const chat = chatOf(id);
		chat.commands = (request.body as { commands: ChatCommand[] }).commands;
		emit(id, chat.sockets, { type: "commands", commands: chat.commands });
		return reply.status(204).send();
	});

	// Replace the model list and send it to every attachment, as the host does.
	app.post("/__test/chats/:id/models", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const chat = chatOf(id);
		chat.models = (request.body as { models: ChatModelInfo[] }).models;
		emit(id, chat.sockets, { type: "models", models: chat.models });
		return reply.status(204).send();
	});

	// Set the context figures (body: usedTokens, windowTokens, cache) and send
	// them to every attachment, as the host does after a request; later
	// attachments get them too.
	app.post("/__test/chats/:id/context", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const chat = chatOf(id);
		chat.context = request.body as Record<string, unknown>;
		emit(id, chat.sockets, { ...chat.context, type: "context" });
		return reply.status(204).send();
	});

	// Every raw frame the fake received, so a test can compare bytes.
	app.get("/__test/chats/:id/received", async (request) => {
		const id = (request.params as { id: string }).id;
		return { received: chats.get(id)?.received ?? [] };
	});

	// Close every attachment from the agent's side with a code and reason.
	app.post("/__test/chats/:id/close", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { code: number; reason: string };
		for (const peer of chats.get(id)?.sockets ?? []) peer.close(body.code, body.reason);
		return reply.status(204).send();
	});

	// One raw text frame of the given size, for the relay's frame cap.
	app.post("/__test/chats/:id/raw", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { bytes: number };
		const frame = "x".repeat(body.bytes);
		for (const peer of chats.get(id)?.sockets ?? []) peer.send(frame);
		return reply.status(204).send();
	});

	// The answers the browsers sent, so a Playwright test can read them back.
	app.get("/__test/chats/:id/answers", async (request) => {
		const id = (request.params as { id: string }).id;
		return { answers: chats.get(id)?.answers ?? [] };
	});
}

/** The tool result Claude Code writes for AskUserQuestion: `"question"="answer"` pairs. */
function questionResultText(answers: Record<string, string>): string {
	const pairs = Object.entries(answers).map(
		([question, answer]) => `"${question}"="${answer}"`,
	);
	return pairs.length > 0
		? `Your questions have been answered: ${pairs.join(", ")}. You can now continue with these answers in mind.`
		: "The user did not answer the questions.";
}

function withoutType<T extends { type: string }>(card: T): Omit<T, "type"> {
	const { type: _type, ...rest } = card;
	return rest;
}
