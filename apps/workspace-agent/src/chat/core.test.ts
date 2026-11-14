import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatOpenCard,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CardAnswer, CardOutcome, ContextFigures } from "./agent.js";
import { ChatCore } from "./core.js";
import {
	attached as attachedTo,
	attach as attachTo,
	type Client,
	FakeAgent,
	ID,
	permissionCard,
	types,
} from "./test-fixtures/core-harness.js";

const MODE = {
	id: "default",
	label: "Ask",
	description: "Asks first.",
	warning: false,
	plan: false,
};
const FIGURES: ContextFigures = { usedTokens: 10, windowTokens: 100, cache: null };

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

const attach = () => attachTo(core.socketPath);
const attached = () => attachedTo(core.socketPath);

describe("the core stays agent-neutral", () => {
	test("core.ts, agent.ts, open-cards.ts and decisions.ts import nothing from the Claude SDK or adapter", async () => {
		for (const file of [
			"core.ts",
			"agent.ts",
			"open-cards.ts",
			"decisions.ts",
			"handoff.ts",
		]) {
			const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
			const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
			expect(imports.length).toBeGreaterThan(0);
			for (const path of imports) {
				expect(path, file).not.toMatch(/^@anthropic-ai\//);
				expect(path, file).not.toMatch(/claude-adapter/);
			}
		}
	});
});

describe("socket", () => {
	test("is private to the workspace user", async () => {
		const info = await stat(core.socketPath);
		expect(info.mode & 0o777).toBe(0o600);
	});

	test("stop stops the agent and closes every attachment", async () => {
		const client = await attached();
		await core.stop();
		await client.closed;
		expect(agent.calls).toContainEqual(["stop"]);
	});

	test("refuses an attachment past the limit", async () => {
		const clients: Client[] = [];
		for (let i = 0; i < MAX_ATTACHMENTS_PER_TERMINAL; i++)
			clients.push(await attached());
		const extra = await attach();
		await extra.closed;
		expect(extra.events).toMatchObject([
			{ type: "error", message: "Too many open chat views." },
		]);
	});

	test("a frame that does not parse closes that attachment", async () => {
		const client = await attached();
		client.socket.write("{not json\n");
		await client.closed;
	});
});

describe("attach order", () => {
	test("snapshot, history, decisions, in progress, held, then the latest state", async () => {
		agent.sink.models([
			{
				value: "default",
				displayName: "Default",
				description: "",
				supportsAutoMode: true,
			},
		]);
		agent.sink.commands([
			{ name: "help", description: "", argumentHint: "", terminalOnly: false },
		]);
		agent.sink.modes([MODE]);
		agent.sink.mcp([{ name: "docs", status: "connected" }]);
		agent.sink.rules([{ rule: "Bash(ls)", label: "ls" }] as never);
		agent.sink.emit({ type: "turn.started", at: 1 });
		agent.sink.emit({ type: "text.delta", messageId: "m1", text: "Hel" });
		agent.sink.emit({ type: "text.delta", messageId: "m1", text: "lo" });
		agent.historyEvents = [
			{ type: "shell", id: "old", command: "ls", state: "done" } as never,
		];
		agent.running = [
			{ type: "shell", id: "old", command: "ls", state: "running" } as never,
			{ type: "shell", id: "new", command: "pwd", state: "running" } as never,
		];
		agent.historyContext = FIGURES;
		let release!: () => void;
		agent.gate = new Promise((resolve) => {
			release = resolve;
		});
		const client = await attach();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["history", true]));
		agent.sink.emit({ type: "text.delta", messageId: "m1", text: "!" });
		release();
		await vi.waitFor(() => expect(types(client)).toContain("context"));
		expect(types(client)).toEqual([
			"snapshot",
			"shell",
			"text.delta",
			"shell",
			"text.delta",
			"models",
			"modes",
			"settings",
			"rules",
			"commands",
			"mcp",
			"context",
		]);
		const [snapshot, , partial, running, held] = client.events;
		expect(snapshot).toMatchObject({ sessionId: ID, seq: 0, turnRunning: true });
		expect(partial).toMatchObject({ messageId: "m1", text: "Hello" });
		expect(running).toMatchObject({ id: "new" });
		expect(held).toMatchObject({ text: "!" });
		// Every numbered frame follows the snapshot with no gap.
		const seqs = client.events.slice(1).map((event) => (event as { seq: number }).seq);
		expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
	});

	test("models or context that arrived during the read are not sent twice", async () => {
		agent.historyContext = FIGURES;
		let release!: () => void;
		agent.gate = new Promise((resolve) => {
			release = resolve;
		});
		const client = await attach();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["history", false]));
		agent.sink.models([]);
		agent.sink.context(FIGURES);
		release();
		await vi.waitFor(() => expect(types(client)).toContain("rules"));
		expect(types(client).filter((type) => type === "models")).toHaveLength(1);
		expect(types(client).filter((type) => type === "context")).toHaveLength(1);
	});

	test("modes or MCP servers that arrived during the read are not sent twice", async () => {
		let release!: () => void;
		agent.gate = new Promise((resolve) => {
			release = resolve;
		});
		const client = await attach();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["history", false]));
		agent.sink.modes([MODE]);
		agent.sink.mcp([{ name: "docs", status: "starting" }]);
		release();
		await vi.waitFor(() => expect(types(client)).toContain("rules"));
		expect(types(client).filter((type) => type === "modes")).toHaveLength(1);
		expect(types(client).filter((type) => type === "mcp")).toHaveLength(1);
	});

	test("a browser attaching before any modes or MCP list exists is sent neither", async () => {
		const client = await attached();
		expect(types(client)).not.toContain("modes");
		expect(types(client)).not.toContain("mcp");
	});

	test("a finished turn forgets its streamed reply", async () => {
		agent.sink.emit({ type: "turn.started", at: 1 });
		agent.sink.emit({ type: "text.delta", messageId: "m1", text: "Hi" });
		agent.sink.emit({ type: "turn.finished", status: "done", at: 2 });
		const client = await attached();
		expect(client.events[0]).toMatchObject({ type: "snapshot", turnRunning: false });
		expect(types(client)).not.toContain("text.delta");
	});

	test("an event larger than a frame is not relayed, and numbering goes on", async () => {
		const client = await attached();
		agent.sink.emit({
			type: "error",
			message: "x".repeat(MAX_CHAT_SERVER_FRAME_BYTES),
		});
		agent.sink.emit({ type: "error", message: "small" });
		await vi.waitFor(() =>
			expect(client.events.at(-1)).toMatchObject({ message: "small" }),
		);
		expect(client.events.filter((event) => event.type === "error")).toHaveLength(1);
	});
});

describe("the frame cap on an attach", () => {
	const huge = "x".repeat(MAX_CHAT_SERVER_FRAME_BYTES);

	test("an oversized replayed event is dropped and the rest of the replay arrives", async () => {
		agent.historyEvents = [
			{ type: "error", message: "before" },
			{ type: "error", message: huge },
			{ type: "error", message: "after" },
		];
		const client = await attached();
		expect(
			client.events.filter((e) => e.type === "error").map((e) => e.message),
		).toEqual(["before", "after"]);
		// The next attach is served the same way: nothing killed the relay.
		const again = await attached();
		expect(again.events.filter((e) => e.type === "error")).toHaveLength(2);
	});

	test("an oversized in-progress event or streamed reply is dropped", async () => {
		agent.sink.emit({ type: "turn.started", at: 1 });
		agent.sink.emit({ type: "text.delta", messageId: "m1", text: huge });
		agent.running = [
			{ type: "error", message: huge },
			{ type: "error", message: "running" },
		];
		const client = await attached();
		expect(types(client)).not.toContain("text.delta");
		expect(
			client.events.filter((e) => e.type === "error").map((e) => e.message),
		).toEqual(["running"]);
	});

	test("every frame the attach sends is within the cap", async () => {
		agent.historyEvents = [{ type: "error", message: huge }];
		const client = await attached();
		for (const event of client.events) {
			expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
				MAX_CHAT_SERVER_FRAME_BYTES,
			);
		}
	});
});

describe("modes and MCP servers", () => {
	test("each change is broadcast to every browser, and the latest is kept for a later one", async () => {
		const a = await attached();
		agent.sink.modes([MODE]);
		agent.sink.mcp([{ name: "docs", status: "failed" }]);
		agent.sink.mcp([{ name: "docs", status: "connected" }]);
		await vi.waitFor(() =>
			expect(a.events.filter((e) => e.type === "mcp")).toHaveLength(2),
		);
		expect(a.events.find((e) => e.type === "modes")).toMatchObject({ modes: [MODE] });
		const late = await attach();
		await vi.waitFor(() => expect(types(late)).toContain("mcp"));
		expect(late.events.find((e) => e.type === "mcp")).toMatchObject({
			servers: [{ name: "docs", status: "connected" }],
		});
		expect(late.events.find((e) => e.type === "modes")).toMatchObject({
			modes: [MODE],
		});
	});

	test("an unchanged list is not broadcast again, for any of the four lists", async () => {
		const a = await attached();
		const model = {
			value: "default",
			displayName: "Default",
			description: "",
			supportsAutoMode: true,
		};
		const command = {
			name: "help",
			description: "",
			argumentHint: "",
			terminalOnly: false,
		};
		agent.sink.modes([MODE]);
		agent.sink.modes([{ ...MODE }]);
		agent.sink.mcp([]);
		agent.sink.mcp([]);
		agent.sink.models([model]);
		agent.sink.models([{ ...model }]);
		agent.sink.commands([command]);
		agent.sink.commands([{ ...command }]);
		agent.sink.emit({ type: "error", message: "marker" });
		await vi.waitFor(() => expect(types(a)).toContain("error"));
		expect(types(a).filter((t) => t === "modes")).toHaveLength(1);
		expect(types(a).filter((t) => t === "mcp")).toHaveLength(1);
		expect(types(a).filter((t) => t === "models")).toHaveLength(1);
		expect(types(a).filter((t) => t === "commands")).toHaveLength(1);
		// A changed list still goes out.
		agent.sink.models([{ ...model, displayName: "Other" }]);
		agent.sink.commands([{ ...command, description: "Help" }]);
		await vi.waitFor(() =>
			expect(types(a).filter((t) => t === "models")).toHaveLength(2),
		);
		expect(types(a).filter((t) => t === "commands")).toHaveLength(2);
	});
});

describe("sign-in", () => {
	test("each answer is broadcast, even unchanged, and the latest goes to a later browser", async () => {
		const a = await attached();
		agent.sink.signIn("signedOut");
		agent.sink.signIn("signedOut");
		await vi.waitFor(() =>
			expect(a.events.filter((e) => e.type === "signIn")).toHaveLength(2),
		);
		agent.sink.signIn("signedIn");
		const late = await attached();
		expect(late.events.filter((e) => e.type === "signIn")).toMatchObject([
			{ state: "signedIn" },
		]);
	});

	test("a browser attaching before the agent has answered is sent none", async () => {
		const client = await attached();
		expect(types(client)).not.toContain("signIn");
	});

	test("an answer that arrived during the read is not sent twice", async () => {
		let release!: () => void;
		agent.gate = new Promise((resolve) => {
			release = resolve;
		});
		const client = await attach();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["history", false]));
		agent.sink.signIn("signedOut");
		release();
		await vi.waitFor(() => expect(types(client)).toContain("rules"));
		expect(types(client).filter((type) => type === "signIn")).toHaveLength(1);
	});

	test("Check again goes to the driver", async () => {
		const client = await attached();
		client.send({ type: "signIn.check" });
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["checkSignIn"]));
	});

	test("a conversation reset sends it again after the snapshot", async () => {
		const client = await attached();
		agent.sink.signIn("signedOut");
		await vi.waitFor(() => expect(types(client)).toContain("signIn"));
		const before = client.events.length;
		agent.sink.conversationReset(null);
		await vi.waitFor(() => expect(client.events.length).toBe(before + 4));
		expect(types(client).slice(before)).toEqual([
			"snapshot",
			"settings",
			"rules",
			"signIn",
		]);
	});
});

describe("browser messages", () => {
	test("each goes to the driver", async () => {
		const client = await attached();
		client.send({ type: "send", text: "hi", attachments: [] });
		client.send({ type: "interrupt" });
		client.send({ type: "set", model: "opus" });
		client.send({ type: "rule.revoke", rule: "Bash(ls)" });
		client.send({ type: "subagent.watch", toolUseId: "toolu_1" });
		client.send({ type: "subagent.unwatch", toolUseId: "toolu_1" });
		await vi.waitFor(() => expect(agent.calls).toHaveLength(7));
		expect(agent.calls.slice(1)).toEqual([
			["send", "hi", []],
			["interrupt"],
			["set", { model: "opus" }],
			["revokeRule", "Bash(ls)"],
			["watch", "toolu_1"],
			["unwatch", "toolu_1"],
		]);
	});

	test("any other message that reaches the core is refused, not dropped", async () => {
		const onMessage = (
			core as unknown as {
				onMessage(client: unknown, message: unknown): Promise<void>;
			}
		).onMessage.bind(core);
		await expect(onMessage({}, { type: "future.message" })).rejects.toThrow(
			"That message is not supported.",
		);
	});

	test("a rename answer goes to the asker alone, unnumbered", async () => {
		const asker = await attached();
		const other = await attached();
		asker.send({ type: "rename", title: "New name" });
		await vi.waitFor(() =>
			expect(asker.events.at(-1)).toEqual({ type: "rename.result", ok: true }),
		);
		expect(types(other)).not.toContain("rename.result");
	});

	test("a driver's error goes to the sender alone", async () => {
		const sender = await attached();
		const other = await attached();
		agent.failSend = "Wait for the shell command to finish.";
		sender.send({ type: "send", text: "hi", attachments: [] });
		await vi.waitFor(() =>
			expect(sender.events.at(-1)).toMatchObject({
				type: "error",
				message: "Wait for the shell command to finish.",
			}),
		);
		expect(types(other)).not.toContain("error");
	});

	test("a closed attachment stops watching its last subagent", async () => {
		const client = await attached();
		client.send({ type: "subagent.watch", toolUseId: "toolu_1" });
		client.send({ type: "subagent.watch", toolUseId: "toolu_2" });
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["watch", "toolu_2"]));
		client.socket.destroy();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["unwatch", "toolu_2"]));
		expect(agent.calls).not.toContainEqual(["unwatch", "toolu_1"]);
	});
});

describe("cards", () => {
	function openCard(
		id: string,
		settle: (answer: CardAnswer) => CardOutcome | Promise<CardOutcome>,
		signal?: AbortSignal,
	): CardAnswer[] {
		const answers: CardAnswer[] = [];
		agent.sink.openCard(
			permissionCard(id),
			(answer) => {
				answers.push(answer);
				return settle(answer);
			},
			signal,
		);
		return answers;
	}

	test("an open card is in the snapshot, and the first fitting answer wins", async () => {
		const answers = openCard("toolu_1", () => ({ decision: "allowed" }));
		const client = await attached();
		expect(client.events[0]).toMatchObject({ cards: [{ id: "toolu_1" }] });
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "nope" });
		client.send({ type: "question.answer", id: "toolu_1", answers: {} });
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "allow" });
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "deny" });
		await vi.waitFor(() => expect(types(client)).toContain("card.resolved"));
		expect(answers).toEqual([
			{ type: "permission", optionId: "allow", message: undefined },
		]);
		expect(client.events.at(-1)).toMatchObject({
			type: "card.resolved",
			id: "toolu_1",
			decision: "allowed",
		});
	});

	test("a driver that waits still claims the card first, and its error goes to the answerer", async () => {
		let finish!: (outcome: CardOutcome) => void;
		const answers = openCard(
			"toolu_1",
			() =>
				new Promise<CardOutcome>((resolve) => {
					finish = resolve;
				}),
		);
		const client = await attached();
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "allow" });
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "deny" });
		await vi.waitFor(() => expect(answers).toHaveLength(1));
		finish({ decision: "allowed", error: "Allowed this once." });
		await vi.waitFor(() =>
			expect(client.events.at(-1)).toMatchObject({
				type: "error",
				message: "Allowed this once.",
			}),
		);
		expect(answers).toHaveLength(1);
	});

	test("a decision is replayed after the tool call it answered", async () => {
		openCard("toolu_1", () => ({ decision: "denied" }));
		const first = await attached();
		first.send({ type: "permission.answer", id: "toolu_1", optionId: "deny" });
		await vi.waitFor(() => expect(types(first)).toContain("card.resolved"));
		agent.historyEvents = [
			{ type: "tool.started", id: "toolu_1", toolName: "Bash", input: {} } as never,
		];
		const second = await attached();
		expect(types(second).slice(0, 3)).toEqual([
			"snapshot",
			"tool.started",
			"card.resolved",
		]);
		expect(second.events[2]).toMatchObject({ decision: "denied" });
	});

	test("an abort clears the card and settles it as closed", async () => {
		const stop = new AbortController();
		const answers = openCard("toolu_1", () => ({}), stop.signal);
		const client = await attached();
		stop.abort();
		await vi.waitFor(() => expect(types(client)).toContain("card.resolved"));
		expect(answers).toEqual([{ type: "closed" }]);
		expect(client.events.at(-1)).toEqual(
			expect.not.objectContaining({ decision: expect.anything() }),
		);
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "allow" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(answers).toHaveLength(1);
	});

	test("a question card takes a question answer", async () => {
		const answers: CardAnswer[] = [];
		agent.sink.openCard(
			{ type: "question", id: "toolu_q", questions: [] } as unknown as ChatOpenCard,
			(answer) => {
				answers.push(answer);
				return {};
			},
		);
		const client = await attached();
		client.send({ type: "question.answer", id: "toolu_q", answers: { Q: "A" } });
		await vi.waitFor(() => expect(types(client)).toContain("card.resolved"));
		expect(answers).toEqual([
			{ type: "question", answers: { Q: "A" }, notes: undefined },
		]);
		expect(client.events.at(-1)).toEqual({
			type: "card.resolved",
			id: "toolu_q",
			sessionId: ID,
			seq: expect.any(Number),
		});
	});
});

describe("conversation reset", () => {
	test("each attachment gets a fresh snapshot and the latest state; decisions are forgotten", async () => {
		openCard();
		const client = await attached();
		client.send({ type: "permission.answer", id: "toolu_1", optionId: "allow" });
		await vi.waitFor(() => expect(types(client)).toContain("card.resolved"));
		const before = client.events.length;
		agent.sink.conversationReset(FIGURES);
		await vi.waitFor(() => expect(client.events.length).toBe(before + 4));
		expect(types(client).slice(before)).toEqual([
			"snapshot",
			"settings",
			"rules",
			"context",
		]);
		agent.historyEvents = [
			{ type: "tool.started", id: "toolu_1", toolName: "Bash", input: {} } as never,
		];
		const later = await attached();
		expect(types(later)).not.toContain("card.resolved");

		function openCard() {
			agent.sink.openCard(permissionCard("toolu_1"), () => ({ decision: "allowed" }));
		}
	});

	test("an attachment still reading its replay is closed so it reattaches", async () => {
		let release!: () => void;
		agent.gate = new Promise((resolve) => {
			release = resolve;
		});
		const client = await attach();
		await vi.waitFor(() => expect(agent.calls).toContainEqual(["history", false]));
		agent.sink.conversationReset(null);
		await client.closed;
		release();
	});
});
