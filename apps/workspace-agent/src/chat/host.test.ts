import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Options,
	PermissionResult,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatServerEvent,
	MAX_ATTACHMENTS_PER_TERMINAL,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaudeLimitWindows } from "./claude-adapter.js";
import { ChatHost, type ChatSdk } from "./host.js";
import { readLines } from "./wire.js";

const ID = "5d0f4a7e-0a51-4b8e-9d0e-6c3f1b2a9e10";

/** A stand-in for one SDK query that the test drives by hand. */
class FakeQuery {
	readonly sent: SDKUserMessage[] = [];
	readonly calls: string[] = [];
	private readonly queue: SDKMessage[] = [];
	private wake: (() => void) | null = null;
	private ended = false;

	constructor(
		readonly options: Options,
		prompt: AsyncIterable<SDKUserMessage>,
	) {
		void (async () => {
			for await (const message of prompt) this.sent.push(message);
		})();
	}

	emit(message: Partial<SDKMessage> & { type: string }): void {
		this.queue.push(message as SDKMessage);
		this.wake?.();
	}

	ask(toolName: string, input: Record<string, unknown>, toolUseID: string) {
		const controller = new AbortController();
		const result = this.options.canUseTool?.(toolName, input, {
			signal: controller.signal,
			toolUseID,
			requestId: toolUseID,
		}) as Promise<PermissionResult>;
		return { result, controller };
	}

	async interrupt() {
		this.calls.push("interrupt");
		return undefined;
	}
	async setModel(model?: string) {
		this.calls.push(`model:${model}`);
	}
	async setPermissionMode(mode: string) {
		this.calls.push(`mode:${mode}`);
	}
	async applyFlagSettings(settings: Record<string, unknown>) {
		this.calls.push(`effort:${settings.effortLevel}`);
	}
	close() {
		this.ended = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
		for (;;) {
			const next = this.queue.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.ended) return;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = null;
		}
	}
}

interface Client {
	socket: Socket;
	events: ChatServerEvent[];
	send: (message: unknown) => void;
	closed: Promise<void>;
}

let dir: string;
let host: ChatHost;
let queries: FakeQuery[];
let posted: ClaudeLimitWindows[];
let exists: boolean;

function sdk(): ChatSdk {
	return {
		query: ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
			const fake = new FakeQuery(params.options, params.prompt);
			queries.push(fake);
			return fake as unknown as Query;
		}) as ChatSdk["query"],
		sessionExists: async () => exists,
		sessionMessages: async () => [
			{
				type: "user",
				uuid: "u1",
				session_id: ID,
				message: { role: "user", content: "earlier question" },
				parent_tool_use_id: null,
				parent_agent_id: null,
			},
		],
	};
}

async function attach(): Promise<Client> {
	const socket = connect(host.socketPath);
	const events: ChatServerEvent[] = [];
	readLines(socket, 16 * 1024 * 1024, (line) => events.push(JSON.parse(line)));
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	return {
		socket,
		events,
		closed,
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
	};
}

function ofType<T extends ChatServerEvent["type"]>(client: Client, type: T) {
	return client.events.filter(
		(e): e is Extract<ChatServerEvent, { type: T }> => e.type === type,
	);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pk-chat-"));
	await mkdir(join(dir, "projects", "demo"), { recursive: true });
	queries = [];
	posted = [];
	exists = false;
	host = new ChatHost({
		terminalId: ID,
		projectDir: join(dir, "projects", "demo"),
		homeDir: dir,
		socketDir: join(dir, "chat"),
		log: silentLogger(),
		postLimits: async (windows) => {
			posted.push(windows);
		},
		sdk: sdk(),
	});
	await host.start();
});

afterEach(async () => {
	await host.stop();
	await rm(dir, { recursive: true, force: true });
});

describe("starting", () => {
	test("a new chat uses the terminal id as the session id and the shared binary", () => {
		const options = queries[0]?.options;
		expect(options?.sessionId).toBe(ID);
		expect(options?.resume).toBeUndefined();
		expect(options?.pathToClaudeCodeExecutable).toBe(
			"/opt/portikus/coding-agents/bin/claude",
		);
		expect(options?.includePartialMessages).toBe(true);
	});

	test("a chat with a transcript resumes it", async () => {
		await host.stop();
		exists = true;
		queries = [];
		host = new ChatHost({
			terminalId: ID,
			projectDir: join(dir, "projects", "demo"),
			homeDir: dir,
			socketDir: join(dir, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			sdk: sdk(),
		});
		await host.start();
		expect(queries[0]?.options.resume).toBe(ID);
		expect(queries[0]?.options.sessionId).toBeUndefined();
	});

	test("the socket and its directory are the workspace user's alone", async () => {
		expect((await stat(join(dir, "chat"))).mode & 0o777).toBe(0o700);
		expect((await stat(host.socketPath)).mode & 0o777).toBe(0o600);
	});
});

describe("attaching", () => {
	test("the snapshot comes first, then history replayed as events, then the settings", async () => {
		const client = await attach();
		await vi.waitFor(() => expect(client.events.length).toBeGreaterThanOrEqual(5));
		expect(client.events[0]).toMatchObject({
			type: "snapshot",
			sessionId: ID,
			messages: [],
			cards: [],
			turnRunning: false,
			truncated: false,
		});
		expect(client.events.slice(1, 4)).toMatchObject([
			{ type: "turn.started" },
			{ type: "message", id: "u1", role: "user", markdown: "earlier question" },
			{ type: "turn.finished", status: "done" },
		]);
		const seqs = client.events.map((event) => event.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(client.events[4]).toMatchObject({
			type: "settings",
			agent: "claude",
			effort: "high",
		});
	});

	test(`a ${MAX_ATTACHMENTS_PER_TERMINAL + 1}th attachment is refused`, async () => {
		const clients = [];
		for (let i = 0; i < MAX_ATTACHMENTS_PER_TERMINAL; i++) clients.push(await attach());
		const extra = await attach();
		await extra.closed;
		expect(extra.events).toEqual([expect.objectContaining({ type: "error" })]);
		for (const client of clients) expect(client.socket.destroyed).toBe(false);
	});
});

describe("cards", () => {
	test("a question waits, the first answer wins, and both attachments see it resolved", async () => {
		const a = await attach();
		const b = await attach();
		const question = {
			question: "Which colour?",
			header: "Colour",
			multiSelect: false,
			options: [
				{ label: "Red", description: "" },
				{ label: "Blue", description: "" },
			],
		};
		const fake = queries[0] as FakeQuery;
		const { result } = fake.ask(
			"AskUserQuestion",
			{ questions: [question] },
			"toolu_q",
		);
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(ofType(b, "question.requested")).toHaveLength(1));
		expect(ofType(a, "question.requested")[0]).toMatchObject({
			id: "toolu_q",
			questions: [question],
		});

		// No time limit: still open after a while, and in a new attachment's snapshot.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(settled).toBe(false);
		const late = await attach();
		await vi.waitFor(() => expect(ofType(late, "snapshot")).toHaveLength(1));
		expect(ofType(late, "snapshot")[0]?.cards).toMatchObject([
			{ type: "question", id: "toolu_q" },
		]);

		b.send({
			type: "question.answer",
			id: "toolu_q",
			answers: { "Which colour?": "Blue" },
			notes: { "Which colour?": "navy" },
		});
		a.send({
			type: "question.answer",
			id: "toolu_q",
			answers: { "Which colour?": "Red" },
		});
		expect(await result).toEqual({
			behavior: "allow",
			updatedInput: {
				questions: [question],
				answers: { "Which colour?": "Blue" },
				annotations: { "Which colour?": { notes: "navy" } },
			},
		});
		for (const client of [a, b, late]) {
			await vi.waitFor(() =>
				expect(ofType(client, "card.resolved")).toEqual([
					expect.objectContaining({ id: "toolu_q" }),
				]),
			);
		}
	});

	test("a permission answer with an option the card lacks is ignored", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result } = fake.ask("Bash", { command: "rm -rf build" }, "toolu_p");
		await vi.waitFor(() => expect(ofType(a, "permission.requested")).toHaveLength(1));
		a.send({ type: "permission.answer", id: "toolu_p", optionId: "always" });
		a.send({ type: "permission.answer", id: "toolu_p", optionId: "deny" });
		expect((await result).behavior).toBe("deny");
	});

	test("an aborted tool call clears its card", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result, controller } = fake.ask("Bash", { command: "ls" }, "toolu_x");
		await vi.waitFor(() => expect(ofType(a, "permission.requested")).toHaveLength(1));
		controller.abort();
		expect((await result).behavior).toBe("deny");
		await vi.waitFor(() => expect(ofType(a, "card.resolved")).toHaveLength(1));
	});
});

describe("messages and controls", () => {
	test("send echoes the message, starts a turn and reaches the SDK", async () => {
		const a = await attach();
		a.send({ type: "send", text: "hello", attachments: [] });
		const fake = queries[0] as FakeQuery;
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(fake.sent[0]?.message).toEqual({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
		await vi.waitFor(() => expect(ofType(a, "turn.started")).toHaveLength(2));
		expect(ofType(a, "message").at(-1)).toMatchObject({
			role: "user",
			markdown: "hello",
		});

		fake.emit({ type: "result", subtype: "success", is_error: false } as never);
		await vi.waitFor(() =>
			expect(ofType(a, "turn.finished").at(-1)).toMatchObject({ status: "done" }),
		);
	});

	test("a refused attachment is reported to the sender and nothing is sent", async () => {
		const a = await attach();
		a.send({ type: "send", text: "see", attachments: [{ path: "missing.png" }] });
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		expect(queries[0]?.sent).toHaveLength(0);
	});

	test("set goes through the SDK's setters and the new settings are sent", async () => {
		const a = await attach();
		a.send({ type: "set", model: "sonnet", effort: "low", mode: "plan" });
		const fake = queries[0] as FakeQuery;
		await vi.waitFor(() =>
			expect(fake.calls).toEqual(["model:sonnet", "effort:low", "mode:plan"]),
		);
		await vi.waitFor(() =>
			expect(ofType(a, "settings").at(-1)).toMatchObject({
				model: "sonnet",
				effort: "low",
				mode: "plan",
			}),
		);
	});

	test("interrupt stops the running turn", async () => {
		const a = await attach();
		a.send({ type: "send", text: "go", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "turn.started")).toHaveLength(2));
		a.send({ type: "interrupt" });
		const fake = queries[0] as FakeQuery;
		await vi.waitFor(() => expect(fake.calls).toContain("interrupt"));
		fake.emit({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
		} as never);
		await vi.waitFor(() =>
			expect(ofType(a, "turn.finished").at(-1)).toMatchObject({
				status: "interrupted",
			}),
		);
	});

	test("a malformed frame drops that attachment", async () => {
		const a = await attach();
		a.socket.write("{not json\n");
		await a.closed;
	});

	test("rate limit events reach the limits receiver", async () => {
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "allowed",
				rateLimitType: "five_hour",
				utilization: 0.25,
				resetsAt: 1794200000,
			},
		} as never);
		await vi.waitFor(() =>
			expect(posted).toEqual([
				{ five_hour: { used_percentage: 25, resets_at: 1794200000 } },
			]),
		);
	});

	test("the turn in progress is in a new attachment's snapshot", async () => {
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "stream_event",
			event: { type: "message_start", message: { id: "msg_1" } },
		} as never);
		fake.emit({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Work" },
			},
		} as never);
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "snapshot")).toHaveLength(1));
		expect(ofType(a, "snapshot")[0]).toMatchObject({
			turnRunning: true,
			messages: [{ id: "msg_1", role: "assistant", markdown: "Work" }],
		});
		// The running turn is replayed without its finish.
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		expect(ofType(a, "turn.finished")).toHaveLength(0);
	});
});
