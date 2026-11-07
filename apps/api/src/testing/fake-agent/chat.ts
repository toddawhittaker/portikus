import type { WebSocket } from "@fastify/websocket";
import {
	type ChatClientMessage,
	type ChatEffort,
	type ChatMessage,
	type ChatOpenCard,
	type ChatPermissionMode,
	ChatServerEvent,
	MAX_ATTACHMENTS_PER_TERMINAL,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
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

/** What a test reads back: one answer, as the browser sent it. */
type FakeChatAnswer = Extract<
	ChatClientMessage,
	{ type: "permission.answer" | "question.answer" }
>;

interface FakeChat {
	seq: number;
	started: boolean;
	messages: ChatMessage[];
	openCards: ChatOpenCard[];
	answers: FakeChatAnswer[];
	received: string[];
	settings: { model: string; effort: ChatEffort; mode: ChatPermissionMode };
	sockets: Set<WebSocket>;
}

/**
 * The agent's chat socket, scripted (SPEC.md §9.7). The first attachment
 * starts one fixed turn; later attachments get a snapshot that holds the
 * cards still open. Every frame is checked against the contract before it
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
				messages: [
					{ id: "m-old-user", role: "user", markdown: "Earlier question" },
					{ id: "m-old-assistant", role: "assistant", markdown: "Earlier answer" },
				],
				openCards: [],
				answers: [],
				received: [],
				settings: { model: "claude-sonnet-4-5", effort: "medium", mode: "default" },
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

	function runScriptedTurn(id: string): void {
		const chat = chatOf(id);
		const all = chat.sockets;
		emit(id, all, { type: "turn.started" });
		for (const text of ["Looking ", "at the ", "project."]) {
			emit(id, all, { type: "text.delta", messageId: "m-turn", text });
		}
		const final: ChatMessage = {
			id: "m-turn",
			role: "assistant",
			markdown: FINAL_MARKDOWN,
		};
		chat.messages.push(final);
		emit(id, all, { type: "message", ...final });
		emit(id, all, {
			type: "tool.started",
			id: "tool-1",
			name: "Read",
			title: "Read README.md",
			input: { file_path: "README.md" },
		});
		emit(id, all, {
			type: "tool.output",
			id: "tool-1",
			part: { type: "text", text: "# README" },
		});
		emit(id, all, {
			type: "tool.output",
			id: "tool-1",
			part: { type: "image", mediaType: "image/png", data: TINY_PNG },
		});
		emit(id, all, { type: "tool.finished", id: "tool-1", isError: false });
		chat.openCards.push(QUESTION_CARD, PERMISSION_CARD);
		emit(id, all, { type: "question.requested", ...withoutType(QUESTION_CARD) });
		emit(id, all, { type: "permission.requested", ...withoutType(PERMISSION_CARD) });
		emit(id, all, { type: "turn.finished", status: "done" });
	}

	function answer(id: string, message: FakeChatAnswer): void {
		const chat = chatOf(id);
		const card = chat.openCards.find((one) => one.id === message.id);
		// The first answer wins; a late one is dropped.
		if (!card) return;
		chat.openCards = chat.openCards.filter((one) => one.id !== message.id);
		chat.answers.push(message);
		emit(id, chat.sockets, { type: "card.resolved", id: message.id });
	}

	function handle(id: string, message: ChatClientMessage): void {
		const chat = chatOf(id);
		switch (message.type) {
			case "send": {
				const user: ChatMessage = {
					id: `m-user-${chat.seq}`,
					role: "user",
					markdown: message.text,
				};
				chat.messages.push(user);
				emit(id, chat.sockets, { type: "message", ...user });
				const reply: ChatMessage = {
					id: `m-reply-${chat.seq}`,
					role: "assistant",
					markdown: "This is a canned reply.",
				};
				chat.messages.push(reply);
				emit(id, chat.sockets, { type: "message", ...reply });
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
			case "interrupt":
				emit(id, chat.sockets, { type: "turn.finished", status: "interrupted" });
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
					handle(id, JSON.parse(text) as ChatClientMessage);
				} catch {
					// A frame the script cannot read is ignored, like an unknown type.
				}
			});
			emit(id, [socket], {
				type: "snapshot",
				messages: chat.messages,
				cards: chat.openCards,
				turnRunning: false,
				truncated: false,
			});
			if (!chat.started) {
				chat.started = true;
				runScriptedTurn(id);
			}
		},
	);

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

function withoutType<T extends { type: string }>(card: T): Omit<T, "type"> {
	const { type: _type, ...rest } = card;
	return rest;
}
