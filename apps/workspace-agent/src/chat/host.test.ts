import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Options,
	PermissionResult,
	PermissionUpdate,
	Query,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatServerEvent,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_IMAGE_BYTES,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaudeLimitWindows } from "./claude-adapter.js";
import { ChatHost, type ChatSdk } from "./host.js";
import { chatSessionsDir, recordChatSession } from "./session-record.js";
import { readLines } from "./wire.js";

const ID = "5d0f4a7e-0a51-4b8e-9d0e-6c3f1b2a9e10";
const OLD = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";

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

	ask(
		toolName: string,
		input: Record<string, unknown>,
		toolUseID: string,
		suggestions?: PermissionUpdate[],
	) {
		const controller = new AbortController();
		const result = this.options.canUseTool?.(toolName, input, {
			signal: controller.signal,
			toolUseID,
			requestId: toolUseID,
			...(suggestions ? { suggestions } : {}),
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
	/** The flag layer as the SDK documents it: top-level keys shallow-merge. */
	readonly flags: Record<string, unknown> = {};
	/** When set, each flag change waits on it, so a test can overlap two. */
	flagGate: Promise<void> | null = null;
	flagFailure: Error | null = null;
	async applyFlagSettings(settings: Record<string, unknown>) {
		if ("permissions" in settings) {
			this.calls.push(`permissions:${JSON.stringify(settings.permissions)}`);
		} else {
			this.calls.push(`effort:${settings.effortLevel}`);
		}
		await this.flagGate;
		if (this.flagFailure) throw this.flagFailure;
		Object.assign(this.flags, settings);
	}
	/** What `supportedCommands()` answers; a test may set a failure instead. */
	commandList: { name: string; description: string; argumentHint: string }[] = [];
	commandFailure: Error | null = null;
	async supportedCommands() {
		if (this.commandFailure) throw this.commandFailure;
		return this.commandList;
	}
	/** What the plan-usage request answers; a test may set a failure instead. */
	usage: Record<string, unknown> = { rate_limits_available: false, rate_limits: null };
	usageFailure: Error | null = null;
	usageCalls: unknown[] = [];
	async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts: unknown) {
		this.usageCalls.push(opts);
		if (this.usageFailure) throw this.usageFailure;
		return this.usage;
	}
	/** What `getContextUsage()` answers; null makes it fail, as an older SDK would. */
	contextWindow: number | null = null;
	async getContextUsage() {
		if (this.contextWindow === null) throw new Error("unsupported");
		return { maxTokens: this.contextWindow };
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
/** The transcript reads, by session id, and what each returns. */
let reads: string[];
let transcript: () => Promise<SessionMessage[]>;

const EARLIER: SessionMessage[] = [
	{
		type: "user",
		uuid: "u1",
		session_id: ID,
		message: { role: "user", content: "earlier question" },
		parent_tool_use_id: null,
		parent_agent_id: null,
		timestamp: "2026-11-07T10:00:00.000Z",
	} as SessionMessage,
];

function sdk(): ChatSdk {
	return {
		query: ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
			const fake = new FakeQuery(params.options, params.prompt);
			queries.push(fake);
			return fake as unknown as Query;
		}) as ChatSdk["query"],
		sessionExists: async () => exists,
		sessionMessages: async (id) => {
			reads.push(id);
			return transcript();
		},
	};
}

async function attach(): Promise<Client> {
	const socket = connect(host.socketPath);
	const events: ChatServerEvent[] = [];
	readLines(socket, 16 * 1024 * 1024, (line) => events.push(JSON.parse(line)));
	// The host destroys every attachment on stop; a reset then is expected.
	socket.on("error", () => undefined);
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	return {
		socket,
		events,
		closed,
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
	};
}

function delta(text: string) {
	return {
		type: "stream_event",
		event: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
	} as never;
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
	reads = [];
	transcript = async () => EARLIER;
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
		// The picker offers bypass, which the SDK refuses without this.
		expect(options?.allowDangerouslySkipPermissions).toBe(true);
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

	test("a chat resuming an ended one continues that session and replays it", async () => {
		await host.stop();
		exists = true;
		queries = [];
		host = new ChatHost({
			terminalId: ID,
			sessionId: OLD,
			projectDir: join(dir, "projects", "demo"),
			homeDir: dir,
			socketDir: join(dir, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			sdk: sdk(),
		});
		await host.start();
		expect(queries[0]?.options.resume).toBe(OLD);
		const client = await attach();
		await vi.waitFor(() => expect(ofType(client, "settings")).toHaveLength(1));
		expect(reads).toEqual([OLD]);
		expect(client.events[0]).toMatchObject({ type: "snapshot", sessionId: ID });
		expect(ofType(client, "message")[0]).toMatchObject({
			markdown: "earlier question",
		});
	});

	test("after /clear the tab follows the new session, and the next start resumes it", async () => {
		const NEW = "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e";
		const client = await attach();
		await vi.waitFor(() => expect(ofType(client, "rules")).toHaveLength(1));
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "system",
			subtype: "init",
			session_id: ID,
			model: "m",
			permissionMode: "default",
		} as never);
		fake.emit({
			type: "system",
			subtype: "init",
			session_id: NEW,
			model: "m",
			permissionMode: "default",
		} as never);
		await vi.waitFor(() => expect(ofType(client, "snapshot")).toHaveLength(2));
		const after = client.events.slice(
			client.events.lastIndexOf(ofType(client, "snapshot")[1] as ChatServerEvent),
		);
		expect(after.filter((e) => e.type === "message")).toEqual([]);
		await vi.waitFor(async () =>
			expect(await readFile(join(chatSessionsDir(dir), ID), "utf8")).toBe(NEW),
		);

		// A restarted host reads the record and resumes the new session.
		await host.stop();
		exists = true;
		queries = [];
		reads = [];
		host = new ChatHost({
			terminalId: ID,
			sessionId: await recordChatSession(dir, ID),
			projectDir: join(dir, "projects", "demo"),
			homeDir: dir,
			socketDir: join(dir, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			sdk: sdk(),
		});
		await host.start();
		expect(queries[0]?.options.resume).toBe(NEW);
		const again = await attach();
		await vi.waitFor(() => expect(ofType(again, "settings")).toHaveLength(1));
		expect(reads).toEqual([NEW]);
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
		expect(client.events[0]).toEqual({
			type: "snapshot",
			sessionId: ID,
			seq: expect.any(Number),
			cards: [],
			turnRunning: false,
			truncated: false,
		});
		const at = Date.parse("2026-11-07T10:00:00.000Z");
		expect(client.events.slice(1, 4)).toMatchObject([
			{ type: "turn.started", at },
			{ type: "message", id: "u1", role: "user", markdown: "earlier question" },
			{ type: "turn.finished", status: "done", at },
		]);
		const seqs = client.events.map((event) => event.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(client.events[4]).toMatchObject({
			type: "settings",
			agent: "claude",
			effort: "high",
		});
		expect(client.events[5]).toMatchObject({ type: "rules", rules: [] });
	});

	test("events during the transcript read come after the replay, numbered in order, without doubling the partial reply", async () => {
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "stream_event",
			event: { type: "message_start", message: { id: "msg_1" } },
		} as never);
		fake.emit(delta("Wo"));
		let release: () => void = () => undefined;
		const reading = new Promise<void>((resolve) => {
			release = resolve;
		});
		transcript = async () => {
			await reading;
			return EARLIER;
		};
		const client = await attach();
		await vi.waitFor(() => expect(reads).toHaveLength(1));
		fake.emit(delta("rk"));
		const { result } = fake.ask("Bash", { command: "ls" }, "toolu_during");
		void result;
		// Let the host take both before the read finishes.
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await vi.waitFor(() => expect(ofType(client, "settings")).toHaveLength(1));
		const seqs = client.events.slice(1).map((event) => event.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length);
		const types = client.events.map((event) => event.type);
		expect(types.indexOf("permission.requested")).toBeGreaterThan(
			types.lastIndexOf("message"),
		);
		expect(ofType(client, "snapshot")[0]?.cards).toEqual([]);
		expect(ofType(client, "permission.requested")).toHaveLength(1);
		const text = ofType(client, "text.delta")
			.map((event) => event.text)
			.join("");
		expect(text).toBe("Work");
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

	for (const [capabilities, expected] of [
		[["ask_user_question_unanswered_v1"], { "Which size?": { unanswered: "skipped" } }],
		[[], undefined],
	] as const) {
		test(`a skipped question is marked only when init allows it (${capabilities.length > 0})`, async () => {
			const a = await attach();
			const fake = queries[0] as FakeQuery;
			fake.emit({
				type: "system",
				subtype: "init",
				model: "claude-haiku-4-5",
				permissionMode: "default",
				capabilities: [...capabilities],
			} as never);
			await vi.waitFor(() =>
				expect(ofType(a, "settings").at(-1)?.model).toBe("claude-haiku-4-5"),
			);
			const options = [
				{ label: "A", description: "" },
				{ label: "B", description: "" },
			];
			const questions = [
				{ question: "Which colour?", header: "Colour", multiSelect: false, options },
				{ question: "Which size?", header: "Size", multiSelect: false, options },
			];
			const { result } = fake.ask("AskUserQuestion", { questions }, "toolu_s");
			await vi.waitFor(() => expect(ofType(a, "question.requested")).toHaveLength(1));
			a.send({
				type: "question.answer",
				id: "toolu_s",
				answers: { "Which colour?": "A" },
			});
			const answered = (await result) as { updatedInput: Record<string, unknown> };
			expect(answered.updatedInput.annotations).toEqual(expected);
		});
	}

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

describe("session rules", () => {
	/** What Claude Code suggests for a `sed -i` call, as the real CLI sent it, plus a session rule. */
	const SED_SUGGESTIONS: PermissionUpdate[] = [
		{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "sed -i 's/a/b/' a.txt" }],
			behavior: "allow",
			destination: "localSettings",
		},
		{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "sed:*" }],
			behavior: "allow",
			destination: "session",
		},
		{ type: "setMode", mode: "acceptEdits", destination: "session" },
	];

	test("Always allow holds session rules in the host and hands the rest to the SDK", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result } = fake.ask(
			"Bash",
			{ command: "sed -i x" },
			"toolu_s",
			SED_SUGGESTIONS,
		);
		await vi.waitFor(() => expect(ofType(a, "permission.requested")).toHaveLength(1));
		const card = ofType(a, "permission.requested")[0];
		expect(card?.options.find((option) => option.id === "always")?.label).toBe(
			`Always allow the command "sed -i 's/a/b/' a.txt" in this project, saved to your local project settings; "sed" commands in this session; file edits without asking in this session`,
		);
		a.send({ type: "permission.answer", id: "toolu_s", optionId: "always" });
		expect(await result).toEqual({
			behavior: "allow",
			updatedInput: { command: "sed -i x" },
			updatedPermissions: [SED_SUGGESTIONS[0], SED_SUGGESTIONS[2]],
		});
		expect(fake.calls).toEqual(['permissions:{"allow":["Bash(sed:*)"]}']);
		await vi.waitFor(() =>
			expect(ofType(a, "rules").at(-1)?.rules).toEqual([
				{ rule: "Bash(sed:*)", description: '"sed" commands in this session' },
			]),
		);

		// A browser attaching later is told the rules in force.
		const b = await attach();
		await vi.waitFor(() => expect(ofType(b, "rules").at(-1)?.rules).toHaveLength(1));

		a.send({ type: "rule.revoke", rule: "Bash(sed:*)" });
		await vi.waitFor(() => expect(fake.calls.at(-1)).toBe("permissions:null"));
		await vi.waitFor(() => expect(ofType(b, "rules").at(-1)?.rules).toEqual([]));
	});

	test("revoking one of two rules keeps the other in force", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		for (const [id, content] of [
			["toolu_1", "sed:*"],
			["toolu_2", "ls:*"],
		] as const) {
			const { result } = fake.ask("Bash", { command: content }, id, [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: content }],
					behavior: "allow",
					destination: "session",
				},
			]);
			await vi.waitFor(() =>
				expect(ofType(a, "permission.requested").some((c) => c.id === id)).toBe(true),
			);
			a.send({ type: "permission.answer", id, optionId: "always" });
			expect(await result).toEqual({
				behavior: "allow",
				updatedInput: { command: content },
			});
		}
		a.send({ type: "rule.revoke", rule: "Bash(sed:*)" });
		await vi.waitFor(() =>
			expect(fake.calls.at(-1)).toBe('permissions:{"allow":["Bash(ls:*)"]}'),
		);
		a.send({ type: "rule.revoke", rule: "Bash(unknown)" });
		await vi.waitFor(() => expect(ofType(a, "rules").at(-1)?.rules).toHaveLength(1));
		expect(fake.calls.filter((call) => call.startsWith("permissions"))).toHaveLength(3);
	});

	/** Ask for a Bash command whose Always allow grants `content` for the session. */
	async function askSessionRule(
		a: Client,
		fake: FakeQuery,
		id: string,
		content: string,
	) {
		const asked = fake.ask("Bash", { command: content }, id, [
			{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: content }],
				behavior: "allow",
				destination: "session",
			},
		]);
		await vi.waitFor(() =>
			expect(ofType(a, "permission.requested").some((c) => c.id === id)).toBe(true),
		);
		return { result: asked.result };
	}

	test("two Always allow answers sent together keep both rules", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result: first } = await askSessionRule(a, fake, "toolu_1", "sed:*");
		const { result: second } = await askSessionRule(a, fake, "toolu_2", "grep:*");
		let release = () => {};
		fake.flagGate = new Promise((resolve) => {
			release = resolve;
		});
		a.send({ type: "permission.answer", id: "toolu_1", optionId: "always" });
		a.send({ type: "permission.answer", id: "toolu_2", optionId: "always" });
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
		release();
		await Promise.all([first, second]);
		await vi.waitFor(() =>
			expect(fake.flags.permissions).toEqual({
				allow: ["Bash(sed:*)", "Bash(grep:*)"],
			}),
		);
		await vi.waitFor(() =>
			expect(
				ofType(a, "rules")
					.at(-1)
					?.rules.map((held) => held.rule),
			).toEqual(["Bash(sed:*)", "Bash(grep:*)"]),
		);
	});

	test("a revoke sent while a grant is waiting stays revoked", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result: first } = await askSessionRule(a, fake, "toolu_1", "rm:*");
		a.send({ type: "permission.answer", id: "toolu_1", optionId: "always" });
		await first;
		await vi.waitFor(() =>
			expect(fake.flags.permissions).toEqual({ allow: ["Bash(rm:*)"] }),
		);

		const { result: second } = await askSessionRule(a, fake, "toolu_2", "ls:*");
		let release = () => {};
		fake.flagGate = new Promise((resolve) => {
			release = resolve;
		});
		a.send({ type: "permission.answer", id: "toolu_2", optionId: "always" });
		a.send({ type: "rule.revoke", rule: "Bash(rm:*)" });
		await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
		release();
		await second;
		await vi.waitFor(() => expect(fake.calls).toHaveLength(3));
		await vi.waitFor(() =>
			expect(fake.flags.permissions).toEqual({ allow: ["Bash(ls:*)"] }),
		);
		await vi.waitFor(() =>
			expect(
				ofType(a, "rules")
					.at(-1)
					?.rules.map((held) => held.rule),
			).toEqual(["Bash(ls:*)"]),
		);
	});

	test("a grant that fails still runs the tool once and says the rule was not saved", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result } = await askSessionRule(a, fake, "toolu_1", "sed:*");
		fake.flagFailure = new Error("settings_not_applied");
		a.send({ type: "permission.answer", id: "toolu_1", optionId: "always" });
		expect((await result).behavior).toBe("allow");
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		expect(ofType(a, "error")[0]?.message).toBe(
			"Allowed this once. The Always allow rule could not be saved, so Claude will ask again next time.",
		);
		expect(ofType(a, "rules").at(-1)?.rules).toEqual([]);
	});

	// The SDK shallow-merges flag settings by top-level key, so an effort
	// change leaves the session rules in force.
	test("changing effort keeps the session rules", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const { result } = await askSessionRule(a, fake, "toolu_1", "sed:*");
		a.send({ type: "permission.answer", id: "toolu_1", optionId: "always" });
		await result;
		a.send({ type: "set", effort: "low" });
		await vi.waitFor(() => expect(fake.calls.at(-1)).toBe("effort:low"));
		await vi.waitFor(() => expect(fake.flags.effortLevel).toBe("low"));
		expect(fake.flags.permissions).toEqual({ allow: ["Bash(sed:*)"] });
		expect(ofType(a, "rules").at(-1)?.rules).toHaveLength(1);
	});

	test("a mode change Claude makes mid-turn reaches the picker", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "system",
			subtype: "status",
			status: null,
			permissionMode: "acceptEdits",
		} as never);
		await vi.waitFor(() =>
			expect(ofType(a, "settings").at(-1)).toMatchObject({ mode: "acceptEdits" }),
		);
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
		await vi.waitFor(() => expect(ofType(a, "turn.finished")).toHaveLength(2));
		expect(ofType(a, "turn.finished").at(-1)).toMatchObject({ status: "done" });
		const started = ofType(a, "turn.started").at(-1)?.at ?? 0;
		expect(started).toBeGreaterThan(Date.parse("2026-11-07T10:00:00.000Z"));
		expect(ofType(a, "turn.finished").at(-1)?.at).toBeGreaterThanOrEqual(started);
	});

	test("an image a tool returns over the cap arrives as imageOmitted, not a dropped frame", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_img",
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "A".repeat(Math.ceil((MAX_CHAT_IMAGE_BYTES + 3) / 3) * 4),
								},
							},
						],
					},
				],
			},
			parent_tool_use_id: null,
		} as never);
		await vi.waitFor(() => expect(ofType(a, "tool.finished")).toHaveLength(1));
		expect(ofType(a, "tool.output")).toMatchObject([
			{ id: "toolu_img", part: { type: "imageOmitted", mediaType: "image/png" } },
		]);
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
				rateLimitType: "seven_day",
				utilization: 0.25,
				resetsAt: 1794200000,
			},
		} as never);
		await vi.waitFor(() =>
			expect(posted).toEqual([
				{ seven_day: { used_percentage: 25, resets_at: 1794200000 } },
			]),
		);
	});

	test("the turn in progress is in a new attachment's snapshot", async () => {
		const fake = queries[0] as FakeQuery;
		fake.emit({
			type: "stream_event",
			event: { type: "message_start", message: { id: "msg_1" } },
		} as never);
		fake.emit(delta("Work"));
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "snapshot")).toHaveLength(1));
		expect(ofType(a, "snapshot")[0]).toMatchObject({ turnRunning: true });
		// After the replay, the partial reply arrives as one delta.
		await vi.waitFor(() =>
			expect(ofType(a, "text.delta")).toEqual([
				expect.objectContaining({ messageId: "msg_1", text: "Work" }),
			]),
		);
		const types = a.events.map((event) => event.type);
		expect(types.indexOf("text.delta")).toBeGreaterThan(types.indexOf("message"));
		// The running turn is replayed without its finish.
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		expect(ofType(a, "turn.finished")).toHaveLength(0);
	});

	test("a session that ends clears its cards, finishes the turn and restarts on the next send", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		a.send({ type: "send", text: "go", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "turn.started")).toHaveLength(2));
		const { result } = fake.ask("Bash", { command: "ls" }, "toolu_end");
		await vi.waitFor(() => expect(ofType(a, "permission.requested")).toHaveLength(1));
		fake.close();
		expect((await result).behavior).toBe("deny");
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		expect(ofType(a, "card.resolved")).toEqual([
			expect.objectContaining({ id: "toolu_end" }),
		]);
		expect(ofType(a, "turn.finished").at(-1)).toMatchObject({ status: "error" });
		a.send({ type: "send", text: "again", attachments: [] });
		a.send({ type: "send", text: "and again", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "message")).toHaveLength(4));
		// Both sends share the one restarted session.
		expect(queries).toHaveLength(2);
		await vi.waitFor(() => expect(queries[1]?.sent).toHaveLength(2));
	});
});

const INIT = {
	type: "system",
	subtype: "init",
	session_id: ID,
	model: "m",
	permissionMode: "default",
	slash_commands: ["compact", "config", "deploy", "login"],
	terminal_slash_commands: ["deploy"],
} as never;

const COMMANDS = [
	{ name: "compact", description: "Shrink the conversation", argumentHint: "[focus]" },
	{ name: "config", description: "Open settings", argumentHint: "" },
	{ name: "deploy", description: "Ship it", argumentHint: "" },
];

describe("slash commands", () => {
	test("init lists the commands with descriptions and marks the terminal-only ones", async () => {
		const fake = queries[0] as FakeQuery;
		fake.commandList = COMMANDS;
		const a = await attach();
		fake.emit(INIT);
		await vi.waitFor(() => expect(ofType(a, "commands")).toHaveLength(1));
		expect(ofType(a, "commands")[0]?.commands).toEqual([
			{
				name: "compact",
				description: "Shrink the conversation",
				argumentHint: "[focus]",
				terminalOnly: false,
			},
			{ name: "config", description: "Open settings", terminalOnly: true },
			{ name: "deploy", description: "Ship it", terminalOnly: true },
		]);
	});

	test("a browser that attaches later gets the last known list, after the rules", async () => {
		const fake = queries[0] as FakeQuery;
		fake.commandList = COMMANDS;
		fake.emit(INIT);
		await vi.waitFor(async () => {
			const probe = await attach();
			await vi.waitFor(() => expect(ofType(probe, "rules")).toHaveLength(1));
			expect(ofType(probe, "commands")).toHaveLength(1);
		});
		const late = await attach();
		await vi.waitFor(() => expect(ofType(late, "commands")).toHaveLength(1));
		const types = late.events.map((event) => event.type);
		expect(types.indexOf("commands")).toBeGreaterThan(types.indexOf("rules"));
	});

	test("a commands_changed message replaces the list for every browser; an equal list is not resent", async () => {
		const fake = queries[0] as FakeQuery;
		fake.commandList = COMMANDS;
		const a = await attach();
		const b = await attach();
		fake.emit(INIT);
		await vi.waitFor(() => expect(ofType(b, "commands")).toHaveLength(1));
		fake.emit({
			type: "system",
			subtype: "commands_changed",
			commands: [{ name: "review", description: "Review a PR", argumentHint: "<pr>" }],
		} as never);
		await vi.waitFor(() => expect(ofType(a, "commands")).toHaveLength(2));
		await vi.waitFor(() => expect(ofType(b, "commands")).toHaveLength(2));
		expect(ofType(a, "commands")[1]?.commands).toEqual([
			{
				name: "review",
				description: "Review a PR",
				argumentHint: "<pr>",
				terminalOnly: false,
			},
		]);
		fake.emit({
			type: "system",
			subtype: "commands_changed",
			commands: [{ name: "review", description: "Review a PR", argumentHint: "<pr>" }],
		} as never);
		fake.emit(INIT);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(ofType(a, "commands")).toHaveLength(3);
	});

	test("when the descriptions cannot be read, init's names are listed without them", async () => {
		const fake = queries[0] as FakeQuery;
		fake.commandFailure = new Error("no answer");
		const a = await attach();
		fake.emit(INIT);
		await vi.waitFor(() => expect(ofType(a, "commands")).toHaveLength(1));
		expect(
			ofType(a, "commands")[0]?.commands.map((c) => [c.name, c.terminalOnly]),
		).toEqual([
			["compact", false],
			["config", true],
			["deploy", true],
			["login", true],
		]);
		expect(ofType(a, "commands")[0]?.commands[0]?.description).toBe("");
	});
});

describe("permission answers", () => {
	test("an answer carrying a message and a mode, and one carrying neither, both settle the card", async () => {
		const a = await attach();
		const fake = queries[0] as FakeQuery;
		const first = fake.ask("ExitPlanMode", { plan: "p" }, "toolu_plan1");
		const second = fake.ask("ExitPlanMode", { plan: "p" }, "toolu_plan2");
		await vi.waitFor(() => expect(ofType(a, "permission.requested")).toHaveLength(2));
		a.send({
			type: "permission.answer",
			id: "toolu_plan1",
			optionId: "allow",
			mode: "acceptEdits",
			message: "go on",
		});
		a.send({ type: "permission.answer", id: "toolu_plan2", optionId: "allow" });
		expect((await first.result).behavior).toBe("allow");
		expect((await second.result).behavior).toBe("allow");
	});
});

describe("plan usage", () => {
	const usage = (utilization: number, resets: string) => ({
		rate_limits_available: true,
		rate_limits: { seven_day: { utilization, resets_at: resets } },
	});

	test("the seven-day figure is read when the session starts and after each result, without the transcript scan", async () => {
		const fake = queries[0] as FakeQuery;
		await vi.waitFor(() => expect(fake.usageCalls).toHaveLength(1));
		expect(fake.usageCalls[0]).toEqual({ skipBehaviors: true });
		expect(posted).toEqual([]);

		fake.usage = usage(41.26, "2026-12-01T09:00:00Z");
		fake.emit({ type: "result", subtype: "success", is_error: false } as never);
		await vi.waitFor(() =>
			expect(posted).toEqual([
				{ seven_day: { used_percentage: 41.3, resets_at: 1796115600 } },
			]),
		);
		expect(fake.usageCalls).toHaveLength(2);
	});

	test("a failed request keeps the last figure and posts nothing", async () => {
		const fake = queries[0] as FakeQuery;
		fake.usage = usage(10, "2026-12-01T09:00:00Z");
		fake.emit({ type: "result", subtype: "success", is_error: false } as never);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		fake.usageFailure = new Error("offline");
		fake.emit({ type: "result", subtype: "success", is_error: false } as never);
		await vi.waitFor(() => expect(fake.usageCalls).toHaveLength(3));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(posted).toHaveLength(1);
	});

	test("a session on an API key posts nothing", async () => {
		const fake = queries[0] as FakeQuery;
		fake.emit({ type: "result", subtype: "success", is_error: false } as never);
		await vi.waitFor(() => expect(fake.usageCalls).toHaveLength(2));
		expect(posted).toEqual([]);
	});
});

describe("context usage", () => {
	const assistant = (usage: Record<string, unknown>, parent: string | null = null) =>
		({
			type: "assistant",
			parent_tool_use_id: parent,
			session_id: ID,
			uuid: randomUUID(),
			message: {
				id: `msg-${randomUUID()}`,
				role: "assistant",
				model: "claude-opus-5-5",
				content: [],
				usage,
			},
		}) as never;

	test("each main-thread request sends the context in use and the cache clock; a subagent's does not", async () => {
		const fake = queries[0] as FakeQuery;
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		const before = Date.now();
		fake.emit(
			assistant({
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 1000,
				cache_creation: {
					ephemeral_1h_input_tokens: 1000,
					ephemeral_5m_input_tokens: 0,
				},
			}),
		);
		await vi.waitFor(() => expect(ofType(a, "context")).toHaveLength(1));
		const first = ofType(a, "context")[0];
		expect(first?.usedTokens).toBe(1015);
		expect(first?.windowTokens).toBeNull();
		expect(first?.cache?.ttlSeconds).toBe(3600);
		expect(first?.cache?.at).toBeGreaterThanOrEqual(before);

		fake.emit(assistant({ input_tokens: 99999, output_tokens: 1 }, "toolu_sub"));
		fake.contextWindow = 200000;
		fake.emit({
			type: "result",
			subtype: "success",
			is_error: false,
			modelUsage: {},
		} as never);
		await vi.waitFor(() => expect(ofType(a, "context")).toHaveLength(2));
		expect(ofType(a, "context")[1]).toMatchObject({
			usedTokens: 1015,
			windowTokens: 200000,
		});
	});

	test("without getContextUsage the window comes from the result's modelUsage", async () => {
		const fake = queries[0] as FakeQuery;
		const a = await attach();
		fake.emit(assistant({ input_tokens: 10, output_tokens: 5 }));
		fake.emit({
			type: "result",
			subtype: "success",
			is_error: false,
			modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } },
		} as never);
		await vi.waitFor(() =>
			expect(ofType(a, "context").at(-1)).toEqual(
				expect.objectContaining({ usedTokens: 15, windowTokens: 1000000, cache: null }),
			),
		);
	});

	test("a later attach gets the live figure at once", async () => {
		const fake = queries[0] as FakeQuery;
		const a = await attach();
		fake.emit(
			assistant({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 90 }),
		);
		await vi.waitFor(() => expect(ofType(a, "context")).toHaveLength(1));
		const b = await attach();
		await vi.waitFor(() => expect(ofType(b, "context")).toHaveLength(1));
		expect(ofType(b, "context")[0]).toMatchObject({
			usedTokens: 100,
			cache: { ttlSeconds: 300 },
		});
		const types = b.events.map((event) => event.type);
		expect(types.indexOf("context")).toBeGreaterThan(types.indexOf("snapshot"));
	});

	test("before any request, an attach works the figure out from the transcript, with the cache unknown", async () => {
		transcript = async () => [
			...EARLIER,
			{
				type: "assistant",
				uuid: "a1",
				session_id: ID,
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: {
					usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 500 },
				},
			} as SessionMessage,
		];
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "context")).toHaveLength(1));
		expect(ofType(a, "context")[0]).toMatchObject({
			usedTokens: 522,
			windowTokens: null,
			cache: null,
		});
	});

	test("an attach to a chat with no requests yet gets no context event", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ofType(a, "context")).toEqual([]);
	});
});

describe("shell commands", () => {
	const result = (turns: number) =>
		({
			type: "result",
			subtype: "success",
			is_error: false,
			num_turns: turns,
		}) as never;

	test("a `!` command runs with no model, shows its output, and is appended without a turn", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		const fake = queries[0] as FakeQuery;
		a.send({ type: "send", text: "  ! pwd; echo hi >&2; exit 4", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "shell")).toHaveLength(2));
		const [running, done] = ofType(a, "shell");
		expect(running).toMatchObject({
			state: "running",
			command: "pwd; echo hi >&2; exit 4",
			output: "",
		});
		expect(done).toMatchObject({
			id: running?.id,
			state: "done",
			output: `${join(dir, "projects", "demo")}\nhi\n`,
			exitCode: 4,
			truncated: false,
		});
		await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
		expect(fake.sent[0]).toMatchObject({
			uuid: running?.id,
			shouldQuery: false,
			message: { content: "<bash-input>pwd; echo hi >&2; exit 4</bash-input>" },
		});
		expect(fake.sent[1]?.shouldQuery).toBe(false);
		expect(String(fake.sent[1]?.message.content)).toContain("Exit code 4");

		// Each append's empty result ends no turn, and the next real turn ends normally.
		fake.emit(result(0));
		fake.emit(result(0));
		a.send({ type: "send", text: "what did it print?", attachments: [] });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(3));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ofType(a, "turn.finished")).toHaveLength(1);
		fake.emit(result(1));
		await vi.waitFor(() => expect(ofType(a, "turn.finished")).toHaveLength(2));
		expect(ofType(a, "turn.started")).toHaveLength(2);
	});

	test("a `!` command is refused while Claude is working", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		a.send({ type: "send", text: "hello", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "turn.started")).toHaveLength(2));
		a.send({ type: "send", text: "!ls", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		expect(ofType(a, "error")[0]?.message).toMatch(/while Claude is working/);
		expect(ofType(a, "shell")).toHaveLength(0);
		expect((queries[0] as FakeQuery).sent).toHaveLength(1);
	});

	test("a message is refused while a command runs, and a late attachment sees it running", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		a.send({ type: "send", text: "!sleep 0.5; echo late", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "shell")).toHaveLength(1));
		a.send({ type: "send", text: "hello", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		const b = await attach();
		await vi.waitFor(() =>
			expect(ofType(b, "shell")[0]).toMatchObject({ state: "running" }),
		);
		await vi.waitFor(() =>
			expect(ofType(b, "shell").at(-1)).toMatchObject({
				state: "done",
				output: "late\n",
			}),
		);
		expect(ofType(a, "turn.started")).toHaveLength(1);
	});

	test("a command with attachments, or one that is too long, is refused", async () => {
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		a.send({ type: "send", text: `!echo ${"x".repeat(5000)}`, attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "error")).toHaveLength(1));
		expect(ofType(a, "shell")).toHaveLength(0);
	});

	test("a command past the time limit is killed and reported with no exit code", async () => {
		await host.stop();
		queries = [];
		host = new ChatHost({
			terminalId: ID,
			projectDir: join(dir, "projects", "demo"),
			homeDir: dir,
			socketDir: join(dir, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			sdk: sdk(),
			shellTimeoutMs: 2000,
		});
		await host.start();
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		a.send({ type: "send", text: "!echo begun; sleep 30", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "shell")).toHaveLength(2), {
			timeout: 10_000,
		});
		expect(ofType(a, "shell")[1]).toMatchObject({ output: "begun\n", exitCode: null });
		await vi.waitFor(() => expect((queries[0] as FakeQuery).sent).toHaveLength(2));
		expect(String((queries[0] as FakeQuery).sent[1]?.message.content)).toContain(
			"time limit",
		);
	});

	test("neither the command nor its output is logged", async () => {
		await host.stop();
		queries = [];
		const { logger, lines } = collectingLogger("debug");
		host = new ChatHost({
			terminalId: ID,
			projectDir: join(dir, "projects", "demo"),
			homeDir: dir,
			socketDir: join(dir, "chat"),
			log: logger,
			postLimits: async () => undefined,
			sdk: sdk(),
		});
		await host.start();
		const a = await attach();
		await vi.waitFor(() => expect(ofType(a, "settings")).toHaveLength(1));
		a.send({ type: "send", text: "!echo SECRET-$((40+2))-MARK", attachments: [] });
		await vi.waitFor(() => expect(ofType(a, "shell")).toHaveLength(2));
		expect(ofType(a, "shell")[1]?.output).toBe("SECRET-42-MARK\n");
		expect(JSON.stringify(lines)).not.toMatch(/SECRET/);
	});
});
