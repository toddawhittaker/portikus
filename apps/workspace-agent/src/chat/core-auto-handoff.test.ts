import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatServerEvent,
	type CodingAgent,
	HANDOFF_PROMPT,
	handoffFirstMessage,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AUTO_HANDOFF_LEAD_MS, type Clock } from "./auto-handoff.js";
import { ChatCore } from "./core.js";
import { readAutoHandoff } from "./session-record.js";
import {
	attached as attachedTo,
	type Client,
	FakeAgent,
	ID,
	types,
} from "./test-fixtures/core-harness.js";

/** The automatic handoff (SPEC.md §10.8), on a clock the test moves by hand. */

const NOTE = "## Goal\n\nFinish the parser.\n\n## Next steps\n\nWrite the tests.";
const HOUR = 3_600_000;

class FakeClock implements Clock {
	time = 1_000_000;
	private timers: { at: number; fire: () => void; live: boolean }[] = [];
	now(): number {
		return this.time;
	}
	after(ms: number, fire: () => void): () => void {
		const timer = { at: this.time + ms, fire, live: true };
		this.timers.push(timer);
		return () => {
			timer.live = false;
		};
	}
	/** Move time on, firing each timer that falls due. */
	advance(ms: number): void {
		this.time += ms;
		for (const timer of this.timers) {
			if (timer.live && timer.at <= this.time) {
				timer.live = false;
				timer.fire();
			}
		}
	}
}

let dir: string;
let agent: FakeAgent;
let core: ChatCore;
let clock: FakeClock;
let ids = 0;
/** The context size each reply reports, by the message it answers. */
let sizes: Record<string, number>;
let ttlSeconds: 300 | 1800 | 3600 | null;

function playAgent(target: FakeAgent): void {
	target.onSend = (text) => {
		if (text === "/clear") {
			target.sink.conversationReset(null);
			return;
		}
		ids += 1;
		target.sink.emit({ type: "turn.started", at: 1 });
		target.sink.emit({ type: "message", id: `u-${ids}`, role: "user", markdown: text });
		target.sink.emit({
			type: "message",
			id: `a-${ids}`,
			role: "assistant",
			markdown: text === HANDOFF_PROMPT ? NOTE : "Done.",
		});
		target.sink.context(
			{
				usedTokens: sizes[text] ?? 100_000,
				windowTokens: 1_000_000,
				cache: ttlSeconds === null ? null : { at: clock.now(), ttlSeconds },
			},
			true,
		);
		target.sink.emit({ type: "turn.finished", status: "done", at: 2 });
	};
}

async function startCore(name: CodingAgent = "claude", fresh = true): Promise<void> {
	if (fresh) {
		dir = await mkdtemp(join(tmpdir(), "pk-auto-"));
		await mkdir(join(dir, ".git", "info"), { recursive: true });
		clock = new FakeClock();
		ids = 0;
		sizes = { small: 20_000 };
		ttlSeconds = 3600;
		agent = new FakeAgent();
		playAgent(agent);
	}
	core = new ChatCore(
		{
			terminalId: ID,
			socketDir: dir,
			homeDir: dir,
			projectDir: dir,
			log: silentLogger(),
			resetWithinMs: 300,
			clock,
		},
		agent,
		name,
	);
	await core.start();
}

afterEach(async () => {
	await core.stop();
	await rm(dir, { recursive: true, force: true });
});

const attached = () => attachedTo(core.socketPath);

function sent(): string[] {
	return agent.calls
		.filter((call) => call[0] === "send")
		.map((call) => call[1] as string);
}

function prompts(): number {
	return sent().filter((text) => text === HANDOFF_PROMPT).length;
}

function last<T extends ChatServerEvent["type"]>(
	client: Client,
	type: T,
): Extract<ChatServerEvent, { type: T }> | undefined {
	return client.events.filter((event) => event.type === type).at(-1) as
		| Extract<ChatServerEvent, { type: T }>
		| undefined;
}

/** Two messages, so the chat starts at 20k and stands at 100k: past 2 × (20k + 8k). */
async function longChat(client: Client): Promise<void> {
	client.send({ type: "send", text: "small", attachments: [] });
	client.send({ type: "send", text: "big", attachments: [] });
	await vi.waitFor(() => expect(sent()).toEqual(["small", "big"]));
}

/** Move to just before the timer, check nothing fired, then onto it. */
async function reachFireTime(): Promise<void> {
	clock.advance(HOUR - AUTO_HANDOFF_LEAD_MS - 1);
	await flush();
	expect(prompts()).toBe(0);
	clock.advance(1);
}

/** Let the core's promises settle. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

async function noticed(client: Client) {
	await vi.waitFor(() => expect(last(client, "handoff.auto")).toBeTruthy());
	const notice = last(client, "handoff.auto");
	if (!notice) throw new Error("no notice");
	return notice;
}

describe("the automatic handoff", () => {
	test("writes the note ten minutes before the one-hour cache goes cold, saves it, and posts a notice", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await reachFireTime();
		const notice = await noticed(client);
		expect(sent()).toEqual(["small", "big", HANDOFF_PROMPT]);
		expect(notice.path).toMatch(/^\.portikus\/handoffs\/.+\.md$/);
		expect(notice.markdown).toBe(NOTE);
		await expect(readFile(join(dir, notice.path), "utf8")).resolves.toBe(NOTE);
		expect(types(client)).not.toContain("handoff.review");
	});

	test("never fires for a five-minute cache", async () => {
		await startCore();
		ttlSeconds = 300;
		const client = await attached();
		await longChat(client);
		clock.advance(2 * HOUR);
		await flush();
		expect(prompts()).toBe(0);
	});

	test("in a Codex chat with the 30-minute cache, writes the note 20 minutes after the last request", async () => {
		await startCore("codex");
		ttlSeconds = 1800;
		const client = await attached();
		await longChat(client);
		clock.advance(20 * 60_000 - 1);
		await flush();
		expect(prompts()).toBe(0);
		clock.advance(1);
		const notice = await noticed(client);
		await expect(readFile(join(dir, notice.path), "utf8")).resolves.toBe(NOTE);
	});

	test("never fires for a model that reports no cache lifetime, as older Codex models do", async () => {
		await startCore("codex");
		ttlSeconds = null;
		const client = await attached();
		await longChat(client);
		clock.advance(2 * HOUR);
		await flush();
		expect(prompts()).toBe(0);
	});

	test("does not fire while a reply runs, and waits for the next idle period", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		agent.sink.emit({ type: "turn.started", at: 3 });
		await reachFireTime();
		await flush();
		agent.sink.emit({ type: "turn.finished", status: "done", at: 4 });
		clock.advance(HOUR);
		await flush();
		expect(prompts()).toBe(0);
	});

	test("does not fire below twice the fresh chat's start size", async () => {
		await startCore();
		sizes.big = 55_000;
		const client = await attached();
		await longChat(client);
		clock.advance(2 * HOUR);
		await flush();
		expect(prompts()).toBe(0);
		expect(await readdir(join(dir, ".portikus", "handoffs")).catch(() => [])).toEqual(
			[],
		);
	});

	test("writes one note per idle period, and a student message arms the next", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await reachFireTime();
		const first = await noticed(client);
		// The note's own turn refreshed the cache; still idle, so no second note.
		clock.advance(2 * HOUR);
		await flush();
		expect(prompts()).toBe(1);

		client.send({ type: "send", text: "more", attachments: [] });
		await vi.waitFor(() => expect(sent().at(-1)).toBe("more"));
		clock.advance(HOUR - AUTO_HANDOFF_LEAD_MS);
		await vi.waitFor(() => expect(prompts()).toBe(2));
		await vi.waitFor(() => expect(last(client, "handoff.auto")?.id).not.toBe(first.id));
	});

	test("a restarted host re-arms from the current cache figures", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await core.stop();
		client.socket.destroy();
		agent = new FakeAgent();
		playAgent(agent);
		await startCore("claude", false);
		const again = await attached();
		clock.advance(HOUR - AUTO_HANDOFF_LEAD_MS);
		await noticed(again);
		expect(prompts()).toBe(1);
		await vi.waitFor(async () =>
			expect((await readAutoHandoff(dir, ID))?.written).toBe(true),
		);

		// Restarted again in the same idle period: no second note.
		await core.stop();
		again.socket.destroy();
		agent = new FakeAgent();
		playAgent(agent);
		await startCore("claude", false);
		clock.advance(2 * HOUR);
		await flush();
		expect(prompts()).toBe(0);
	});

	test("the notice is replayed after the note's turn on a reattach", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await reachFireTime();
		const notice = await noticed(client);
		agent.historyEvents = [
			{ type: "message", id: "u-1", role: "user", markdown: "small" },
			{ type: "message", id: "u-3", role: "user", markdown: HANDOFF_PROMPT },
			{ type: "message", id: "a-3", role: "assistant", markdown: NOTE },
			{ type: "message", id: "u-9", role: "user", markdown: "later" },
		];
		const late = await attached();
		const replayed = late.events
			.filter((event) => event.type === "message" || event.type === "handoff.auto")
			.map((event) => (event.type === "message" ? event.id : event.type));
		expect(replayed).toEqual(["u-1", "u-3", "a-3", "handoff.auto", "u-9"]);
		expect(last(late, "handoff.auto")?.id).toBe(notice.id);
	});

	test("Start fresh resets, leaves the divider, sends the note, then the student's message", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await reachFireTime();
		const notice = await noticed(client);
		client.send({
			type: "handoff.auto.continue",
			id: notice.id,
			text: "Now add tests",
		});
		const first = handoffFirstMessage(notice.path, NOTE);
		await vi.waitFor(() =>
			expect(sent()).toEqual([
				"small",
				"big",
				HANDOFF_PROMPT,
				"/clear",
				first,
				"Now add tests",
			]),
		);
		expect(last(client, "handoff.fresh")).toMatchObject({ path: notice.path });
		// The new conversation has no notices of its own.
		await vi.waitFor(async () =>
			expect((await readAutoHandoff(dir, ID))?.notices).toEqual([]),
		);
	});

	test("only the newest notice can start fresh", async () => {
		await startCore();
		const client = await attached();
		await longChat(client);
		await reachFireTime();
		const older = await noticed(client);
		client.send({ type: "send", text: "more", attachments: [] });
		await vi.waitFor(() => expect(sent().at(-1)).toBe("more"));
		clock.advance(HOUR - AUTO_HANDOFF_LEAD_MS);
		await vi.waitFor(() => expect(last(client, "handoff.auto")?.id).not.toBe(older.id));
		client.send({ type: "handoff.auto.continue", id: older.id });
		await vi.waitFor(() =>
			expect(last(client, "error")?.message).toBe(
				"That handoff note is no longer offered.",
			),
		);
		expect(sent()).not.toContain("/clear");
	});
});
