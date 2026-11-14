import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@portikus/observability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatEventBody } from "./agent.js";
import { ChatCore, SWITCH_BUSY_MESSAGE, SWITCH_SAME_AGENT_MESSAGE } from "./core.js";
import type { Handoff } from "./handoff.js";
import {
	type ChatSwapState,
	readSwapState,
	takeSwapState,
	writeChatSession,
} from "./session-record.js";
import {
	attached as attachedTo,
	FakeAgent,
	ID,
	permissionCard,
	types,
} from "./test-fixtures/core-harness.js";

/** Swapping a chat's agent, as the host core sees it (SPEC.md §10.8). */

let dir: string;
let agent: FakeAgent;
let core: ChatCore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pk-core-"));
	agent = new FakeAgent();
	core = new ChatCore(
		{ terminalId: ID, socketDir: dir, homeDir: dir, log: silentLogger() },
		agent,
		"claude",
	);
	await core.start();
});

afterEach(async () => {
	await core.stop();
	await rm(dir, { recursive: true, force: true });
});

const attached = () => attachedTo(core.socketPath);

describe("agent swaps", () => {
	const OTHER = "22222222-2222-4222-8222-222222222222";

	function reply(text: string): ChatEventBody[] {
		return [
			{ type: "turn.started", at: 1 },
			{ type: "message", id: `u-${text}`, role: "user", markdown: `ask ${text}` },
			{ type: "message", id: `a-${text}`, role: "assistant", markdown: text },
			{ type: "turn.finished", status: "done", at: 2 },
		];
	}

	test("a swap is refused mid-reply, with a card open, or to the agent already running", async () => {
		const asker = await attached();
		asker.send({ type: "agent.switch", agent: "claude" });
		await vi.waitFor(() =>
			expect(asker.events.at(-1)).toMatchObject({
				type: "error",
				message: SWITCH_SAME_AGENT_MESSAGE,
			}),
		);
		agent.sink.emit({ type: "turn.started", at: 1 });
		asker.send({ type: "agent.switch", agent: "codex" });
		await vi.waitFor(() =>
			expect(asker.events.at(-1)).toMatchObject({
				type: "error",
				message: SWITCH_BUSY_MESSAGE,
			}),
		);
		agent.sink.emit({ type: "turn.finished", status: "done", at: 2 });
		agent.sink.openCard(permissionCard("toolu_1"), () => ({}));
		asker.send({ type: "agent.switch", agent: "codex" });
		await vi.waitFor(() =>
			expect(asker.events.filter((event) => event.type === "error")).toHaveLength(3),
		);
		await expect(readSwapState(dir, ID)).resolves.toBeNull();
	});

	test("a prepared swap records the chat so far for the next host, then lets the asker go and stops listening", async () => {
		await writeChatSession(dir, ID, OTHER);
		agent.historyEvents = reply("shown");
		agent.transcriptEvents = [...reply("older"), ...reply("shown")];
		const viewer = await attached();
		const asker = await attached();
		asker.send({ type: "agent.switch", agent: "codex" });
		await asker.closed;
		expect(types(asker)).not.toContain("error");
		await expect(takeSwapState(dir, ID, "codex")).resolves.toEqual({
			switched: true,
			state: {
				sessions: { claude: OTHER },
				earlier: reply("shown"),
				truncated: false,
				log: [
					{
						agent: "claude",
						turns: [
							{ user: "ask older", reply: "older", tools: [] },
							{ user: "ask shown", reply: "shown", tools: [] },
						],
					},
				],
				handoff: null,
			},
		});
		// Nothing reaches the old agent while it waits to be replaced.
		viewer.send({ type: "send", text: "late", attachments: [] });
		await vi.waitFor(() =>
			expect(viewer.events.at(-1)).toMatchObject({
				type: "error",
				message: "This chat is switching agents.",
			}),
		);
		expect(agent.calls.map((call) => call[0])).not.toContain("send");
		await expect(stat(core.socketPath)).rejects.toThrow();
	});

	/** The asker's last error, once one has arrived. */
	async function refusal(asker: Awaited<ReturnType<typeof attached>>): Promise<string> {
		await vi.waitFor(() => expect(types(asker)).toContain("error"));
		const last = asker.events.filter((event) => event.type === "error").at(-1);
		return last?.type === "error" ? last.message : "";
	}

	/** No swap was left for the other agent's host to take up. */
	async function nothingPending(): Promise<void> {
		await expect(takeSwapState(dir, ID, "codex")).resolves.toMatchObject({
			switched: false,
		});
	}

	test("a send still starting its turn refuses the swap", async () => {
		let release: () => void = () => undefined;
		agent.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const asker = await attached();
		asker.send({ type: "send", text: "hi", attachments: [] });
		await vi.waitFor(() =>
			expect(agent.calls.map((call) => call[0])).toContain("send"),
		);
		asker.send({ type: "agent.switch", agent: "codex" });
		expect(await refusal(asker)).toBe(SWITCH_BUSY_MESSAGE);
		release();
		await nothingPending();
	});

	test("a turn that starts while the swap is being prepared refuses it, and the chat goes on", async () => {
		let release: () => void = () => undefined;
		agent.transcriptGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const asker = await attached();
		asker.send({ type: "agent.switch", agent: "codex" });
		await vi.waitFor(() =>
			expect(agent.calls.map((call) => call[0])).toContain("transcript"),
		);
		agent.sink.emit({ type: "turn.started", at: 1 });
		release();
		expect(await refusal(asker)).toBe(SWITCH_BUSY_MESSAGE);
		await nothingPending();
		agent.sink.emit({ type: "turn.finished", status: "done", at: 2 });
		asker.send({ type: "agent.switch", agent: "codex" });
		await asker.closed;
	});

	test("a host not replaced in time takes the chat back and listens again", async () => {
		await core.stop();
		agent = new FakeAgent();
		core = new ChatCore(
			{
				terminalId: ID,
				socketDir: dir,
				homeDir: dir,
				log: silentLogger(),
				replacedWithinMs: 100,
			},
			agent,
			"claude",
		);
		await core.start();
		const asker = await attached();
		asker.send({ type: "agent.switch", agent: "codex" });
		await asker.closed;
		await vi.waitFor(() => expect(stat(core.socketPath)).resolves.toBeTruthy());
		const again = await attached();
		again.send({ type: "send", text: "still here", attachments: [] });
		await vi.waitFor(() =>
			expect(agent.calls.map((call) => call[0])).toContain("send"),
		);
		await nothingPending();
	});

	test("the log kept for the next handoff is capped when it is written", async () => {
		const big = (id: string): ChatEventBody[] => [
			{ type: "turn.started", at: 1 },
			{ type: "message", id: `u-${id}`, role: "user", markdown: "x".repeat(1_500_000) },
			{ type: "turn.finished", status: "done", at: 2 },
		];
		agent.transcriptEvents = [...big("old"), ...big("new")];
		const asker = await attached();
		asker.send({ type: "agent.switch", agent: "codex" });
		await asker.closed;
		const taken = await takeSwapState(dir, ID, "codex");
		expect(taken.state?.log.flatMap((segment) => segment.turns)).toHaveLength(1);
	});

	async function startAfter(
		state: ChatSwapState,
		switched: boolean,
		failAdopt = false,
	): Promise<FakeAgent> {
		await core.stop();
		const next = new FakeAgent();
		next.dropped = 2;
		next.failAdopt = failAdopt;
		next.historyEvents = reply("codex");
		core = new ChatCore(
			{
				terminalId: ID,
				socketDir: dir,
				homeDir: dir,
				log: silentLogger(),
				swap: { state, switched },
			},
			next,
			"codex",
		);
		agent = next;
		await core.start();
		return next;
	}

	const BEFORE: ChatSwapState = {
		sessions: { claude: OTHER },
		earlier: reply("claude"),
		truncated: false,
		log: [
			{ agent: "claude", turns: [{ user: "ask claude", reply: "claude", tools: [] }] },
		],
		handoff: null,
	};

	test("the next host hands its agent the conversation, and the divider stays in the replay after the earlier part", async () => {
		const next = await startAfter(BEFORE, true);
		const adopted = next.calls.find((call) => call[0] === "adopt")?.[1] as Handoff;
		expect(adopted).toMatchObject({ from: "claude", log: BEFORE.log });
		const client = await attached();
		const replay = client.events.filter((event) =>
			["message", "handoff"].includes(event.type),
		);
		expect(
			replay.map((event) =>
				event.type === "message" ? event.markdown : `${event.type}`,
			),
		).toEqual(["ask claude", "claude", "handoff", "ask codex", "codex"]);
		expect(replay.find((event) => event.type === "handoff")).toMatchObject({
			from: "claude",
			to: "codex",
			droppedTurns: 2,
		});
		const saved = await readSwapState(dir, ID);
		expect(saved?.handoff).toEqual({ id: adopted.id, from: "claude", droppedTurns: 2 });
	});

	test("a handoff the agent could not take is marked failed on the divider", async () => {
		await startAfter(BEFORE, true, true);
		const client = await attached();
		expect(client.events.find((event) => event.type === "handoff")).toMatchObject({
			from: "claude",
			to: "codex",
			failed: true,
		});
		const saved = await readSwapState(dir, ID);
		expect(saved?.earlier.at(-1)).toMatchObject({ type: "handoff", failed: true });
	});

	test("a restarted host lets its agent find its place again, with no second divider", async () => {
		await startAfter(BEFORE, true);
		const saved = (await readSwapState(dir, ID)) as ChatSwapState;
		const again = await startAfter(saved, false);
		const adopted = again.calls.find((call) => call[0] === "adopt")?.[1] as Handoff;
		expect(adopted.id).toBe(saved.handoff?.id);
		const client = await attached();
		expect(types(client).filter((type) => type === "handoff")).toHaveLength(1);
	});

	test("a new conversation, as /clear starts, forgets the swaps", async () => {
		await startAfter(BEFORE, true);
		agent.sink.conversationReset(null);
		await vi.waitFor(async () => expect(await readSwapState(dir, ID)).toBeNull());
		const client = await attached();
		expect(types(client)).not.toContain("handoff");
	});
});
