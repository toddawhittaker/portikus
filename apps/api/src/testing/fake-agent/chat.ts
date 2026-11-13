import type { WebSocket } from "@fastify/websocket";
import {
	type ChatCardDecision,
	type ChatClientMessage,
	type ChatCommand,
	type ChatEffort,
	type ChatMcpServer,
	type ChatMessage,
	type ChatModeInfo,
	type ChatModelInfo,
	type ChatOpenCard,
	type ChatPermissionMode,
	ChatServerEvent,
	type CodingAgent,
	chatStartMode,
	isShellCommand,
	MAX_ATTACHMENTS_PER_TERMINAL,
	shellCommandText,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
	CLAUDE_MCP_CARD,
	CLAUDE_MODES,
	CODEX_COMMANDS,
	CODEX_MCP_CARD,
	CODEX_MODELS,
	CODEX_MODES,
	CODEX_PLAN_CARD,
	CODEX_QUESTION_CARD,
	DEFAULT_COMMANDS,
	DEFAULT_MCP,
	DEFAULT_MODELS,
	EARLIER_TURN_AT,
	ELICITATION_NOTICE,
	FINAL_MARKDOWN,
	PERMISSION_CARD,
	QUESTION_CARD,
	TINY_PNG,
} from "./chat-fixtures.js";
import { setCodingAgentTitle } from "./coding-agents.js";
import type { FakeAgentState } from "./state.js";

/** What a test reads back: one answer, as the browser sent it. */
type FakeChatAnswer = Extract<
	ChatClientMessage,
	{ type: "permission.answer" | "question.answer" }
>;

interface FakeChat {
	/** The agent the terminal was created for; it decides the scripted turn and the lists. */
	agent: CodingAgent;
	seq: number;
	started: boolean;
	/** Finished history, replayed to each later attachment as events (SPEC.md §9.7). */
	history: Record<string, unknown>[];
	openCards: ChatOpenCard[];
	answers: FakeChatAnswer[];
	/** What the student answered on each permission card, by tool call id; replayed on attach. */
	decisions: Map<string, ChatCardDecision>;
	received: string[];
	settings: { model: string; effort: ChatEffort; mode: ChatPermissionMode };
	commands: ChatCommand[];
	/** The models on offer; sent on attach, before the settings. */
	models: ChatModelInfo[];
	modes: ChatModeInfo[];
	mcp: ChatMcpServer[];
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
			const codex = terminals.get(id)?.agent === "codex";
			chat = {
				agent: codex ? "codex" : "claude",
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
				decisions: new Map(),
				received: [],
				settings: codex
					? { model: "gpt-5.5", effort: "medium", mode: "onRequest" }
					: { model: "sonnet", effort: "medium", mode: "default" },
				commands: codex ? CODEX_COMMANDS : DEFAULT_COMMANDS,
				models: codex ? CODEX_MODELS : DEFAULT_MODELS,
				modes: codex ? CODEX_MODES : CLAUDE_MODES,
				mcp: DEFAULT_MCP,
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

	/** A tool row that starts, prints its text, and finishes. */
	function toolRow(
		id: string,
		row: { id: string; name: string; title: string; input: unknown },
		output?: string,
	): void {
		const all = chatOf(id).sockets;
		record(id, all, { type: "tool.started", ...row });
		if (output !== undefined) {
			record(id, all, {
				type: "tool.output",
				id: row.id,
				part: { type: "text", text: output },
			});
		}
		record(id, all, { type: "tool.finished", id: row.id, isError: false });
	}

	function streamReply(id: string): void {
		const all = chatOf(id).sockets;
		for (const text of ["Looking ", "at the ", "project."]) {
			emit(id, all, { type: "text.delta", messageId: "m-turn", text });
		}
		const final: ChatMessage = {
			id: "m-turn",
			role: "assistant",
			markdown: FINAL_MARKDOWN,
		};
		record(id, all, { type: "message", ...final });
	}

	function runScriptedTurn(id: string): void {
		const chat = chatOf(id);
		const all = chat.sockets;
		streamReply(id);
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
		// The permission card's tool call, where the answered card leaves its decision.
		record(id, all, {
			type: "tool.started",
			id: PERMISSION_CARD.id,
			name: PERMISSION_CARD.toolName,
			title: PERMISSION_CARD.title,
			input: PERMISSION_CARD.input,
		});
		chat.openCards.push(QUESTION_CARD, PERMISSION_CARD);
		emit(id, all, { type: "question.requested", ...withoutType(QUESTION_CARD) });
		emit(id, all, { type: "permission.requested", ...withoutType(PERMISSION_CARD) });
		record(id, all, { type: "turn.finished", at: Date.now(), status: "done" });
	}

	/**
	 * What a student sends to see Claude's skill and MCP rows: a `Skill` row,
	 * an `mcp__server__tool` row with its approval card, and the notice for an
	 * MCP form the chat cannot show.
	 */
	function runClaudeMcpTurn(id: string): void {
		const chat = chatOf(id);
		const all = chat.sockets;
		toolRow(
			id,
			{ id: "skill-1", name: "Skill", title: "Skill", input: { skill: "pdf" } },
			"Launching skill: pdf",
		);
		record(id, all, {
			type: "tool.started",
			id: CLAUDE_MCP_CARD.id,
			name: CLAUDE_MCP_CARD.toolName,
			title: CLAUDE_MCP_CARD.toolName,
			input: CLAUDE_MCP_CARD.input,
		});
		chat.openCards.push(CLAUDE_MCP_CARD);
		emit(id, all, { type: "permission.requested", ...withoutType(CLAUDE_MCP_CARD) });
		record(id, all, { type: "error", message: ELICITATION_NOTICE });
		record(id, all, { type: "turn.finished", at: Date.now(), status: "done" });
	}

	/**
	 * Codex's first turn: one row of every shape the chat draws, then the
	 * MCP approval, the plan card, a question with no options and one that
	 * asks for a secret, and the notice for an MCP form it cannot show.
	 */
	function runCodexTurn(id: string): void {
		const chat = chatOf(id);
		const all = chat.sockets;
		streamReply(id);
		toolRow(
			id,
			{
				id: "cx-1",
				name: "commandExecution",
				title: "cat README.md",
				input: {
					command: "cat README.md",
					actions: [{ type: "read", path: "README.md" }],
				},
			},
			"# README",
		);
		toolRow(
			id,
			{
				id: "cx-2",
				name: "commandExecution",
				title: "rg answer src",
				input: {
					command: "rg answer src",
					actions: [{ type: "search", query: "answer", path: "src" }],
				},
			},
			"src/answer.ts:1:export const answer = 41;",
		);
		toolRow(id, {
			id: "cx-3",
			name: "fileChange",
			title: "src/answer.ts",
			input: {
				changes: [
					{
						path: "src/answer.ts",
						kind: "update",
						diff: [
							"--- a/src/answer.ts",
							"+++ b/src/answer.ts",
							"@@ -1 +1 @@",
							"-export const answer = 41;",
							"+export const answer = 42;",
							"",
						].join("\n"),
					},
				],
			},
		});
		toolRow(id, {
			id: "cx-4",
			name: "webSearch",
			title: "codex app-server",
			input: { query: "codex app-server" },
		});
		toolRow(id, {
			id: "cx-5",
			name: "imageView",
			title: "diagram.png",
			input: { path: "/home/student/diagram.png" },
		});
		toolRow(id, {
			id: "cx-6",
			name: "collabAgentToolCall",
			title: "spawnAgent",
			input: {
				tool: "spawnAgent",
				receivers: ["child-thread-1"],
				prompt: "Check the tests",
			},
		});
		toolRow(id, {
			id: "cx-7",
			name: "plan",
			title: "Plan",
			input: {
				steps: [
					{ step: "Read the failing test", status: "completed" },
					{ step: "Fix the answer", status: "inProgress" },
					{ step: "Run the tests", status: "pending" },
				],
			},
		});
		// The MCP call waits on its card, which shares the call's id.
		record(id, all, {
			type: "tool.started",
			id: CODEX_MCP_CARD.id,
			name: CODEX_MCP_CARD.toolName,
			title: CODEX_MCP_CARD.title,
			input: CODEX_MCP_CARD.input,
		});
		chat.openCards.push(CODEX_MCP_CARD, CODEX_PLAN_CARD, CODEX_QUESTION_CARD);
		emit(id, all, { type: "permission.requested", ...withoutType(CODEX_MCP_CARD) });
		emit(id, all, { type: "permission.requested", ...withoutType(CODEX_PLAN_CARD) });
		emit(id, all, { type: "question.requested", ...withoutType(CODEX_QUESTION_CARD) });
		record(id, all, { type: "error", message: ELICITATION_NOTICE });
		record(id, all, { type: "turn.finished", at: Date.now(), status: "done" });
	}

	function answer(id: string, message: FakeChatAnswer): void {
		const chat = chatOf(id);
		const card = chat.openCards.find((one) => one.id === message.id);
		// The first answer wins; a late one is dropped.
		if (!card) return;
		// As the host does, ignore an option the card does not offer and keep it open.
		if (
			card.type === "permission" &&
			message.type === "permission.answer" &&
			!card.options.some((option) => option.id === message.optionId)
		) {
			return;
		}
		chat.openCards = chat.openCards.filter((one) => one.id !== message.id);
		chat.answers.push(message);
		const decision =
			message.type === "permission.answer" && card.type === "permission"
				? card.options.find((option) => option.id === message.optionId)?.decision
				: undefined;
		if (decision) chat.decisions.set(message.id, decision);
		emit(id, chat.sockets, {
			type: "card.resolved",
			id: message.id,
			...(decision ? { decision } : {}),
		});
		// Only a question with a tool row (Claude's) has a result to show.
		if (message.type === "question.answer" && card.id === QUESTION_CARD.id) {
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

	function handle(
		id: string,
		key: string,
		message: ChatClientMessage,
		from: WebSocket,
	): void {
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
					chat.decisions.clear();
					emit(id, chat.sockets, {
						type: "snapshot",
						cards: chat.openCards,
						turnRunning: false,
						truncated: false,
					});
					emit(id, chat.sockets, {
						type: "settings",
						agent: chat.agent,
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
				if (chat.agent === "claude" && message.text.trim() === "demo mcp") {
					runClaudeMcpTurn(id);
					return;
				}
				if (first) {
					if (chat.agent === "codex") runCodexTurn(id);
					else runScriptedTurn(id);
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
			case "set": {
				// As the host does: a model without Auto takes a chat in Auto to Ask.
				const mode =
					message.mode ??
					(message.model !== undefined && chat.settings.mode === "auto"
						? chatStartMode(chat.models, message.model)
						: chat.settings.mode);
				chat.settings = {
					model: message.model ?? chat.settings.model,
					effort: message.effort ?? chat.settings.effort,
					mode,
				};
				emit(id, chat.sockets, {
					type: "settings",
					agent: chat.agent,
					...chat.settings,
				});
				return;
			}
			case "rename":
				setCodingAgentTitle(s, key, id, message.title);
				// The answer goes to the asker alone, with no seq, as the host sends it.
				from.send(JSON.stringify({ type: "rename.result", ok: true }));
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
					handle(id, s.keyOf(request), JSON.parse(text) as ChatClientMessage, socket);
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
			// After the history, as the host sends them: one per decision whose tool call it shows.
			for (const event of chat.history) {
				const decision =
					event.type === "tool.started"
						? chat.decisions.get(String(event.id))
						: undefined;
				if (decision) {
					emit(id, [socket], { type: "card.resolved", id: event.id, decision });
				}
			}
			// Before the settings, which tests wait for as the end of an attach.
			emit(id, [socket], { type: "commands", commands: chat.commands });
			emit(id, [socket], { type: "mcp", servers: chat.mcp });
			emit(id, [socket], { type: "models", models: chat.models });
			emit(id, [socket], { type: "modes", modes: chat.modes });
			if (chat.context) emit(id, [socket], { ...chat.context, type: "context" });
			emit(id, [socket], { type: "settings", agent: chat.agent, ...chat.settings });
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

	// Replace the MCP server list and send it to every attachment, as the host does.
	app.post("/__test/chats/:id/mcp", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const chat = chatOf(id);
		chat.mcp = (request.body as { servers: ChatMcpServer[] }).servers;
		emit(id, chat.sockets, { type: "mcp", servers: chat.mcp });
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
