import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatServerEvent } from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { expect, test, vi } from "vitest";
import { ChatHost } from "./host.js";
import { readLines } from "./wire.js";

/**
 * Two turns against the real Claude Code through the Agent SDK, with Haiku:
 * a Bash permission card, a question answered with a note, and the
 * coding-agent state hooks; then bypass mode, which runs Bash with no card
 * (SPEC.md §10.8). Skipped where no local `claude` is installed, as in CI.
 */
const CLAUDE =
	process.env.PORTIKUS_TEST_CLAUDE ?? join(homedir(), ".local", "bin", "claude");
const ID = "3e9f6c1a-2b4d-4c8e-9f1a-5b6c7d8e9f01";

test.skipIf(!existsSync(CLAUDE))(
	"a question with a note reaches the model, the state hooks fire, and bypass runs without a card",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "pk-chat-real-"));
		const project = join(home, "projects", "demo");
		await mkdir(join(project, ".claude"), { recursive: true });
		const marks = join(home, "marks.txt");
		const mark = join(home, "mark.sh");
		await writeFile(
			mark,
			`#!/bin/sh\ncat >/dev/null\necho "$1 $PORTIKUS_TERMINAL" >> ${marks}\n`,
		);
		await chmod(mark, 0o755);
		const hook = (word: string) => [
			{ hooks: [{ type: "command", command: `${mark} ${word}` }] },
		];
		await writeFile(
			join(project, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					UserPromptSubmit: hook("working"),
					PermissionRequest: hook("needs-input"),
					Stop: hook("finished"),
				},
			}),
		);
		process.env.PORTIKUS_TERMINAL = `pk-${ID}`;
		const host = new ChatHost({
			terminalId: ID,
			projectDir: project,
			homeDir: home,
			socketDir: join(home, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			claudePath: CLAUDE,
		});
		await host.start();
		const socket = connect(host.socketPath);
		const events: ChatServerEvent[] = [];
		const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
		readLines(socket, 16 * 1024 * 1024, (line) => {
			const event = JSON.parse(line) as ChatServerEvent;
			events.push(event);
			if (event.type === "permission.requested") {
				send({ type: "permission.answer", id: event.id, optionId: "allow" });
			}
			if (event.type === "question.requested") {
				const question = event.questions[0]?.question as string;
				send({
					type: "question.answer",
					id: event.id,
					answers: { [question]: "Blue" },
					notes: { [question]: "the shade is navy" },
				});
			}
		});
		try {
			await vi.waitFor(() =>
				expect(events.some((e) => e.type === "snapshot")).toBe(true),
			);
			send({ type: "set", model: "haiku" });
			send({
				type: "send",
				text: "First run `touch probe.txt` with the Bash tool. Then use the AskUserQuestion tool to ask me one single-select question, header 'Colour', options 'Red' and 'Blue'. Then reply with exactly what I picked and the note I gave.",
				attachments: [],
			});
			await vi.waitFor(
				() => expect(events.some((e) => e.type === "turn.finished")).toBe(true),
				{ timeout: 170_000, interval: 500 },
			);
			expect(events.some((e) => e.type === "permission.requested")).toBe(true);
			expect(events.some((e) => e.type === "question.requested")).toBe(true);
			const replies = events
				.filter((e) => e.type === "message" && e.role === "assistant")
				.map((e) => (e as { markdown: string }).markdown)
				.join("\n");
			expect(replies.toLowerCase()).toContain("navy");
			expect(existsSync(join(project, "probe.txt"))).toBe(true);
			await vi.waitFor(async () => {
				const fired = await readFile(marks, "utf8");
				for (const word of ["working", "needs-input", "finished"]) {
					expect(fired).toContain(`${word} pk-${ID}`);
				}
			});

			const cardsBefore = events.filter(
				(e) => e.type === "permission.requested",
			).length;
			send({ type: "set", mode: "bypassPermissions" });
			await vi.waitFor(() =>
				expect(events.filter((e) => e.type === "settings").at(-1)).toMatchObject({
					mode: "bypassPermissions",
				}),
			);
			send({
				type: "send",
				text: "Run `touch bypass.txt` with the Bash tool, then say done.",
				attachments: [],
			});
			await vi.waitFor(
				() => expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(2),
				{ timeout: 120_000, interval: 500 },
			);
			expect(existsSync(join(project, "bypass.txt"))).toBe(true);
			expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(
				cardsBefore,
			);
		} finally {
			socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
		}
	},
	300_000,
);

/**
 * A message sent while a turn runs (SPEC.md §10.8): Claude Code takes it in,
 * and the host's turn.started and turn.finished events still come in pairs,
 * ending finished, so the composer's Working state ends with the work.
 */
test.skipIf(!existsSync(CLAUDE))(
	"a message sent while a turn runs reaches Claude, and turns open and close in pairs",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "pk-chat-real-"));
		const project = join(home, "projects", "demo");
		await mkdir(project, { recursive: true });
		const host = new ChatHost({
			terminalId: ID,
			projectDir: project,
			homeDir: home,
			socketDir: join(home, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			claudePath: CLAUDE,
		});
		await host.start();
		const socket = connect(host.socketPath);
		const events: ChatServerEvent[] = [];
		const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
		readLines(socket, 16 * 1024 * 1024, (line) => {
			events.push(JSON.parse(line) as ChatServerEvent);
		});
		const turns = () =>
			events
				.filter((e) => e.type === "turn.started" || e.type === "turn.finished")
				.map((e) => e.type);
		try {
			await vi.waitFor(() =>
				expect(events.some((e) => e.type === "snapshot")).toBe(true),
			);
			send({ type: "set", model: "haiku", mode: "bypassPermissions" });
			send({
				type: "send",
				text: "Run `sleep 8 && touch first.txt` with the Bash tool, then say done.",
				attachments: [],
			});
			await vi.waitFor(
				() => expect(events.some((e) => e.type === "tool.started")).toBe(true),
				{ timeout: 60_000, interval: 200 },
			);
			send({
				type: "send",
				text: "Also run `touch second.txt` with the Bash tool, then say done.",
				attachments: [],
			});
			await vi.waitFor(
				() => {
					expect(existsSync(join(project, "second.txt"))).toBe(true);
					expect(turns().at(-1)).toBe("turn.finished");
				},
				{ timeout: 150_000, interval: 500 },
			);
			// A queued second turn may start just after the first result; let it settle.
			await new Promise((resolve) => setTimeout(resolve, 8_000));
			const kinds = turns();
			expect(kinds).toEqual(
				kinds.map((_, i) => (i % 2 === 0 ? "turn.started" : "turn.finished")),
			);
			expect(kinds.at(-1)).toBe("turn.finished");
			expect(existsSync(join(project, "first.txt"))).toBe(true);
			for (const event of events.filter((e) => e.type === "turn.finished")) {
				expect(event).toMatchObject({ status: "done" });
			}
		} finally {
			socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
		}
	},
	240_000,
);
