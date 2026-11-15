import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatServerEvent,
	type CodingAgent,
	HANDOFF_CONTINUE_LINE,
	HANDOFF_PROMPT,
	handoffFirstMessage,
} from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PORTIKUS_IGNORE_LINES } from "../project-files.js";
import { ChatCore, SWITCH_BUSY_MESSAGE } from "./core.js";
import {
	HANDOFF_BUSY_MESSAGE,
	HANDOFF_EMPTY_MESSAGE,
	HANDOFF_NOT_FINISHED_MESSAGE,
	HANDOFF_RESET_FAILED_MESSAGE,
	HANDOFF_SEND_FAILED_MESSAGE,
	HANDOFF_WAITING_MESSAGE,
	noteHash,
} from "./fresh-start.js";
import { readSwapState } from "./session-record.js";
import {
	attached as attachedTo,
	type Client,
	FakeAgent,
	ID,
	permissionCard,
	types,
} from "./test-fixtures/core-harness.js";

/**
 * Starting fresh with a handoff note (SPEC.md §10.8). The core runs it for
 * every agent, so each test runs for both.
 */

const NOTE = "## Goal\n\nFinish the parser.\n\n## Next steps\n\nWrite the tests.";

let dir: string;
let agent: FakeAgent;
let core: ChatCore;
let play: Script;

/** What the fake agent answers: the note, a reset for /clear, and a reply to anything else. */
interface Script {
	note: string;
	noteStatus: "done" | "interrupted" | "error";
	firstStatus: "done" | "error";
	resets: boolean;
}

async function startCore(name: CodingAgent, script: Partial<Script> = {}) {
	play = {
		note: NOTE,
		noteStatus: "done",
		firstStatus: "done",
		resets: true,
		...script,
	};
	dir = await mkdtemp(join(tmpdir(), "pk-fresh-"));
	await mkdir(join(dir, ".git", "info"), { recursive: true });
	agent = new FakeAgent();
	agent.onSend = (text) => {
		if (text === "/clear") {
			if (play.resets) agent.sink.conversationReset(null);
			return;
		}
		agent.sink.emit({ type: "turn.started", at: 1 });
		agent.sink.emit({
			type: "message",
			id: `u-${text.length}`,
			role: "user",
			markdown: text,
		});
		const reply = text === HANDOFF_PROMPT ? play.note : "Understood.";
		agent.sink.emit({
			type: "message",
			id: `a-${text.length}`,
			role: "assistant",
			markdown: reply,
		});
		const status = text === HANDOFF_PROMPT ? play.noteStatus : play.firstStatus;
		agent.sink.emit({ type: "turn.finished", status, at: 2 });
	};
	core = new ChatCore(
		{
			terminalId: ID,
			socketDir: dir,
			homeDir: dir,
			projectDir: dir,
			log: silentLogger(),
			resetWithinMs: 300,
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

function last<T extends ChatServerEvent["type"]>(
	client: Client,
	type: T,
): Extract<ChatServerEvent, { type: T }> | undefined {
	return client.events.filter((event) => event.type === type).at(-1) as
		| Extract<ChatServerEvent, { type: T }>
		| undefined;
}

async function reviewed(client: Client) {
	await vi.waitFor(() => expect(last(client, "handoff.review")?.review).toBeTruthy());
	const review = last(client, "handoff.review")?.review;
	if (!review) throw new Error("no review");
	return review;
}

async function errorText(client: Client): Promise<string> {
	await vi.waitFor(() => expect(types(client)).toContain("error"));
	return last(client, "error")?.message ?? "";
}

async function notes(): Promise<string[]> {
	return readdir(join(dir, ".portikus", "handoffs")).catch(() => []);
}

describe.each(["claude", "codex"] as const)("a handoff in a %s chat", (name) => {
	test("the fixed prompt is sent, and the reply is saved under .portikus/handoffs/ with the ignore lines in place", async () => {
		await startCore(name);
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		expect(sent()).toEqual([HANDOFF_PROMPT]);
		expect(review.path).toMatch(
			/^\.portikus\/handoffs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/,
		);
		expect(review.markdown).toBe(NOTE);
		await expect(readFile(join(dir, review.path), "utf8")).resolves.toBe(NOTE);
		await expect(
			readFile(join(dir, ".git", "info", "exclude"), "utf8"),
		).resolves.toContain(PORTIKUS_IGNORE_LINES.join("\n"));
		// A browser that attaches later sees the note waiting.
		const late = await attached();
		expect(last(late, "handoff.review")?.review).toEqual(review);
	});

	test("typing /handoff does the same, and the chat offers it as a command", async () => {
		await startCore(name);
		agent.sink.commands([
			{ name: "compact", description: "Compact", terminalOnly: false },
		]);
		const asker = await attached();
		expect(last(asker, "commands")?.commands.map((command) => command.name)).toEqual([
			"compact",
			"handoff",
		]);
		asker.send({ type: "send", text: " /handoff ", attachments: [] });
		await reviewed(asker);
		expect(sent()).toEqual([HANDOFF_PROMPT]);
	});

	test("a handoff is refused while a reply, a card or a ! command runs, and while a note waits", async () => {
		await startCore(name);
		const asker = await attached();
		agent.sink.emit({ type: "turn.started", at: 1 });
		asker.send({ type: "handoff.start" });
		expect(await errorText(asker)).toBe(HANDOFF_BUSY_MESSAGE);
		agent.sink.emit({ type: "turn.finished", status: "done", at: 2 });

		agent.sink.openCard(permissionCard("toolu_1"), () => ({}));
		asker.send({ type: "handoff.start" });
		await vi.waitFor(() =>
			expect(asker.events.filter((event) => event.type === "error")).toHaveLength(2),
		);
		asker.send({ type: "permission.answer", id: "toolu_1", optionId: "allow" });
		await vi.waitFor(() => expect(types(asker)).toContain("card.resolved"));

		agent.running = [
			{
				type: "shell",
				id: "sh-1",
				command: "sleep 9",
				output: "",
				state: "running",
				exitCode: null,
				truncated: false,
			},
		];
		asker.send({ type: "handoff.start" });
		await vi.waitFor(() =>
			expect(asker.events.filter((event) => event.type === "error")).toHaveLength(3),
		);
		agent.running = [];
		expect(sent()).toEqual([]);

		asker.send({ type: "handoff.start" });
		await reviewed(asker);
		asker.send({ type: "handoff.start" });
		await vi.waitFor(() =>
			expect(last(asker, "error")?.message).toBe(HANDOFF_WAITING_MESSAGE),
		);
	});

	test.each([
		[
			"an unfinished turn",
			{ noteStatus: "error" as const },
			HANDOFF_NOT_FINISHED_MESSAGE,
		],
		["an empty reply", { note: "  " }, HANDOFF_EMPTY_MESSAGE],
	])(
		"%s saves nothing, clears nothing, and says why",
		async (_label, script, message) => {
			await startCore(name, script);
			const asker = await attached();
			asker.send({ type: "handoff.start" });
			expect(await errorText(asker)).toBe(message);
			expect(await notes()).toEqual([]);
			expect(types(asker)).not.toContain("handoff.review");
			expect(sent()).toEqual([HANDOFF_PROMPT]);
		},
	);

	test("Cancel keeps the conversation and the saved note", async () => {
		await startCore(name);
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({ type: "handoff.cancel", id: review.id });
		await vi.waitFor(() => expect(last(asker, "handoff.review")?.review).toBeNull());
		expect(sent()).toEqual([HANDOFF_PROMPT]);
		expect(await notes()).toHaveLength(1);
		const late = await attached();
		expect(types(late)).not.toContain("handoff.review");
	});

	test("an edit rewrites the file and the note under review", async () => {
		await startCore(name);
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({
			type: "handoff.edit",
			id: review.id,
			markdown: "## Goal\n\nShorter.",
		});
		await vi.waitFor(() =>
			expect(last(asker, "handoff.review")?.review?.markdown).toBe(
				"## Goal\n\nShorter.",
			),
		);
		await expect(readFile(join(dir, review.path), "utf8")).resolves.toBe(
			"## Goal\n\nShorter.",
		);
	});

	test("Continue resets the conversation, leaves a divider, and sends the note as the first message", async () => {
		await startCore(name);
		const asker = await attached();
		asker.send({ type: "send", text: "earlier work", attachments: [] });
		await vi.waitFor(() => expect(types(asker)).toContain("turn.finished"));
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({ type: "handoff.edit", id: review.id, markdown: "## Goal\n\nEdited." });
		await vi.waitFor(() =>
			expect(last(asker, "handoff.review")?.review?.markdown).toBe(
				"## Goal\n\nEdited.",
			),
		);
		asker.send({ type: "handoff.continue", id: review.id });
		await vi.waitFor(() => expect(sent()).toHaveLength(4));
		const first = handoffFirstMessage(review.path, "## Goal\n\nEdited.");
		expect(sent()).toEqual(["earlier work", HANDOFF_PROMPT, "/clear", first]);
		expect(first.endsWith(HANDOFF_CONTINUE_LINE)).toBe(true);
		await vi.waitFor(() => expect(last(asker, "handoff.fresh")).toBeTruthy());
		const divider = last(asker, "handoff.fresh");
		expect(divider).toMatchObject({ path: review.path });
		expect(divider?.failed).toBeUndefined();
		expect(last(asker, "handoff.review")?.review).toBeNull();
		// The divider is replayed before the new conversation on a reattach.
		const state = await readSwapState(dir, ID);
		expect(state?.earlier).toEqual([
			{
				type: "handoff.fresh",
				id: divider?.id,
				path: review.path,
				hash: noteHash("## Goal\n\nEdited."),
			},
		]);
		// The estimate counts the new conversation alone: the first message.
		agent.sink.context({ usedTokens: 10, windowTokens: 100, cache: null }, true);
		await vi.waitFor(() =>
			expect(last(asker, "context")?.growth).toEqual({
				startTokens: 10,
				messages: 1,
				requests: 1,
				firstMessageTokens: 0,
				firstMessageRequests: 0,
				doneMessages: 0,
				doneTokens: 0,
				doneRequests: 0,
			}),
		);
		// No error reached the student.
		expect(types(asker)).not.toContain("error");
	});

	test("a failed first message keeps the note, marks the divider, and can be sent again", async () => {
		await startCore(name, { firstStatus: "error" });
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({ type: "handoff.continue", id: review.id });
		expect(await errorText(asker)).toBe(HANDOFF_SEND_FAILED_MESSAGE);
		const failed = last(asker, "handoff.fresh");
		expect(failed?.failed).toBe(true);
		expect(await notes()).toHaveLength(1);
		// Unchanged since it was sent, the note goes again at once.
		play.firstStatus = "done";
		asker.send({ type: "handoff.resend", id: failed?.id ?? "" });
		await vi.waitFor(() =>
			expect(last(asker, "handoff.fresh")?.failed).toBeUndefined(),
		);
		expect(sent().at(-1)).toBe(handoffFirstMessage(review.path, NOTE));
		expect(sent().filter((text) => text === "/clear")).toHaveLength(1);
		expect(last(asker, "handoff.fresh")?.id).toBe(failed?.id);
		const state = await readSwapState(dir, ID);
		expect(state?.earlier).toHaveLength(1);
	});

	test("a resend whose note changed shows it for review first, and Continue sends what is shown", async () => {
		await startCore(name, { firstStatus: "error" });
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({ type: "handoff.continue", id: review.id });
		expect(await errorText(asker)).toBe(HANDOFF_SEND_FAILED_MESSAGE);
		const failed = last(asker, "handoff.fresh");
		await writeFile(join(dir, review.path), "## Goal\n\nChanged by someone.");
		play.firstStatus = "done";
		const before = sent().length;
		asker.send({ type: "handoff.resend", id: failed?.id ?? "" });
		await vi.waitFor(() =>
			expect(last(asker, "handoff.review")?.review?.markdown).toBe(
				"## Goal\n\nChanged by someone.",
			),
		);
		// Nothing was sent: the student sees the text first.
		expect(sent()).toHaveLength(before);
		const shown = last(asker, "handoff.review")?.review;
		asker.send({ type: "handoff.continue", id: shown?.id ?? "" });
		await vi.waitFor(() =>
			expect(last(asker, "handoff.fresh")?.failed).toBeUndefined(),
		);
		expect(sent().slice(before)).toEqual([
			handoffFirstMessage(review.path, "## Goal\n\nChanged by someone."),
		]);
		const state = await readSwapState(dir, ID);
		expect(state?.earlier).toEqual([
			{
				type: "handoff.fresh",
				id: failed?.id,
				path: review.path,
				hash: noteHash("## Goal\n\nChanged by someone."),
			},
		]);
	});

	test("a resend naming a divider with a planted path reads nothing", async () => {
		await startCore(name);
		await core.stop();
		const planted = "99999999-9999-4999-8999-999999999999";
		await mkdir(join(dir, ".codex"), { recursive: true });
		await writeFile(join(dir, ".codex", "auth.json"), "secret");
		core = new ChatCore(
			{
				terminalId: ID,
				socketDir: dir,
				homeDir: dir,
				projectDir: join(dir, "project"),
				log: silentLogger(),
				resetWithinMs: 300,
				swap: {
					state: {
						sessions: {},
						earlier: [
							{
								type: "handoff.fresh",
								id: planted,
								path: "../.codex/auth.json",
								failed: true,
							},
						],
						truncated: false,
						log: [],
						handoff: null,
					},
					switched: false,
				},
			},
			agent,
			name,
		);
		await core.start();
		const asker = await attached();
		const before = sent().length;
		asker.send({ type: "handoff.resend", id: planted });
		expect(await errorText(asker)).toBe("That handoff note could not be read.");
		expect(sent()).toHaveLength(before);
	});

	test("a new conversation that never comes leaves the note waiting", async () => {
		await startCore(name, { resets: false });
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		const review = await reviewed(asker);
		asker.send({ type: "handoff.continue", id: review.id });
		expect(await errorText(asker)).toBe(HANDOFF_RESET_FAILED_MESSAGE);
		expect(last(asker, "handoff.review")?.review).toEqual(review);
		expect(types(asker)).not.toContain("handoff.fresh");
	});

	test("a swap is refused while the note is being written", async () => {
		await startCore(name);
		let release: () => void = () => undefined;
		agent.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const asker = await attached();
		asker.send({ type: "handoff.start" });
		await vi.waitFor(() => expect(sent()).toHaveLength(1));
		asker.send({ type: "agent.switch", agent: name === "claude" ? "codex" : "claude" });
		expect(await errorText(asker)).toBe(SWITCH_BUSY_MESSAGE);
		release();
		await reviewed(asker);
	});
});
