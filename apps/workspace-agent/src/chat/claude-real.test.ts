import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ChatServerEvent } from "@portikus/contracts";
import { silentLogger } from "@portikus/observability";
import { expect, test, vi } from "vitest";
import { ChatHost } from "./host.js";
import { chatSessionsDir, recordChatSession } from "./session-record.js";
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

// Claude Code keeps a session folder per project path, named by the path with
// every non-alphanumeric character turned into a dash.
const removeSessionFolder = (project: string) =>
	rm(join(homedir(), ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-")), {
		recursive: true,
		force: true,
	});

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
			postTitle: async () => undefined,
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
			// A new chat starts in Auto; this one needs Ask to raise the card.
			send({ type: "set", model: "haiku", mode: "default" });
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
			// The command list arrives with descriptions, and menu commands are marked.
			await vi.waitFor(() => {
				const listed = events.find((e) => e.type === "commands");
				const commands = listed?.type === "commands" ? listed.commands : [];
				expect(commands.find((c) => c.name === "compact")?.terminalOnly).toBe(false);
				expect(commands.find((c) => c.name === "config")?.terminalOnly).toBe(true);
			});
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
			await removeSessionFolder(project);
		}
	},
	300_000,
);

/**
 * The model list comes from Claude Code itself, before any message, with a
 * Latest row per family and pinned versions after it, and the window is
 * known before the first reply (SPEC.md §10.8).
 */
test.skipIf(!existsSync(CLAUDE))(
	"the model list and context window arrive before any message",
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
			postTitle: async () => undefined,
			claudePath: CLAUDE,
		});
		await host.start();
		const socket = connect(host.socketPath);
		const events: ChatServerEvent[] = [];
		readLines(socket, 16 * 1024 * 1024, (line) => {
			events.push(JSON.parse(line) as ChatServerEvent);
		});
		try {
			await vi.waitFor(
				() => {
					expect(events.some((e) => e.type === "models")).toBe(true);
					expect(events.some((e) => e.type === "context")).toBe(true);
				},
				{ timeout: 60_000, interval: 200 },
			);
			const listed = events.find((e) => e.type === "models");
			const models = listed?.type === "models" ? listed.models : [];
			const values = models.map((row) => row.value);
			expect(values).toContain("default");
			expect(values).toContain("opus");
			// A family's pinned versions are the rows named claude-<family>-….
			expect(values.some((value) => value.startsWith("claude-opus-"))).toBe(true);
			for (const row of models) expect(row.displayName).not.toBe("");
			// Nothing was sent, so the context is empty in a known window.
			const context = events.find((e) => e.type === "context");
			expect(context).toMatchObject({ usedTokens: 0 });
			expect((context as { windowTokens: number | null }).windowTokens).toBeGreaterThan(
				100_000,
			);
		} finally {
			socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
			await removeSessionFolder(project);
		}
	},
	120_000,
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
			postTitle: async () => undefined,
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
					// Haiku may decline the mid-turn message as an injection, so the file is not required.
					expect(turns().at(-1)).toBe("turn.finished");
					expect(
						events.some(
							(e) =>
								e.type === "message" &&
								e.role === "assistant" &&
								e.markdown.includes("second.txt"),
						),
					).toBe(true);
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
			await removeSessionFolder(project);
		}
	},
	240_000,
);

/**
 * /clear starts a new Claude session (SPEC.md §10.8): the host records it,
 * sends a fresh snapshot, and a restarted host resumes the new session, so
 * nothing from before the clear comes back.
 */
test.skipIf(!existsSync(CLAUDE))(
	"/clear moves the tab to a new session that a restarted host resumes",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "pk-chat-real-"));
		const project = join(home, "projects", "demo");
		await mkdir(project, { recursive: true });
		const open = async () => {
			const host = new ChatHost({
				terminalId: ID,
				sessionId: await recordChatSession(home, ID),
				projectDir: project,
				homeDir: home,
				socketDir: join(home, "chat"),
				log: silentLogger(),
				postLimits: async () => undefined,
				postTitle: async () => undefined,
				claudePath: CLAUDE,
			});
			await host.start();
			const socket = connect(host.socketPath);
			const events: ChatServerEvent[] = [];
			readLines(socket, 16 * 1024 * 1024, (line) => {
				events.push(JSON.parse(line) as ChatServerEvent);
			});
			const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
			return { host, socket, events, send };
		};
		let chat = await open();
		try {
			await vi.waitFor(() =>
				expect(chat.events.some((e) => e.type === "snapshot")).toBe(true),
			);
			chat.send({ type: "set", model: "haiku" });
			chat.send({
				type: "send",
				text: "Reply with the word pelican.",
				attachments: [],
			});
			await vi.waitFor(
				() => expect(chat.events.some((e) => e.type === "turn.finished")).toBe(true),
				{ timeout: 90_000, interval: 500 },
			);
			chat.send({ type: "send", text: "/clear", attachments: [] });
			await vi.waitFor(
				async () => {
					const recorded = await readFile(join(chatSessionsDir(home), ID), "utf8");
					expect(recorded).not.toBe(ID);
					expect(chat.events.filter((e) => e.type === "snapshot")).toHaveLength(2);
				},
				{ timeout: 90_000, interval: 500 },
			);

			chat.socket.destroy();
			await chat.host.stop();
			chat = await open();
			await vi.waitFor(() =>
				expect(chat.events.some((e) => e.type === "rules")).toBe(true),
			);
			expect(JSON.stringify(chat.events)).not.toContain("pelican");
		} finally {
			chat.socket.destroy();
			await chat.host.stop();
			await rm(home, { recursive: true, force: true });
			await removeSessionFolder(project);
		}
	},
	240_000,
);

test.skipIf(!existsSync(CLAUDE))(
	"a `!` command runs with no turn, Claude sees its output next turn, and a reattach replays it",
	async () => {
		const shellId = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		const home = await mkdtemp(join(tmpdir(), "pk-chat-real-"));
		const project = join(home, "projects", "demo");
		await mkdir(project, { recursive: true });
		const host = new ChatHost({
			terminalId: shellId,
			projectDir: project,
			homeDir: home,
			socketDir: join(home, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			postTitle: async () => undefined,
			claudePath: CLAUDE,
		});
		await host.start();
		const open = () => {
			const socket = connect(host.socketPath);
			const events: ChatServerEvent[] = [];
			readLines(socket, 16 * 1024 * 1024, (line) => events.push(JSON.parse(line)));
			const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
			return { socket, events, send };
		};
		const first = open();
		try {
			await vi.waitFor(() =>
				expect(first.events.some((e) => e.type === "snapshot")).toBe(true),
			);
			first.send({ type: "set", model: "haiku" });
			first.send({ type: "send", text: "!echo pelican-$((6*7))", attachments: [] });
			await vi.waitFor(
				() =>
					expect(first.events.filter((e) => e.type === "shell").at(-1)).toMatchObject({
						state: "done",
						output: "pelican-42\n",
						exitCode: 0,
					}),
				{ timeout: 30_000 },
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect(first.events.some((e) => e.type === "turn.started")).toBe(false);

			first.send({
				type: "send",
				text: "What exactly did my last shell command print? Reply with that text only.",
				attachments: [],
			});
			await vi.waitFor(
				() => expect(first.events.some((e) => e.type === "turn.finished")).toBe(true),
				{ timeout: 120_000, interval: 500 },
			);
			const replies = first.events
				.filter((e) => e.type === "message" && e.role === "assistant")
				.map((e) => (e as { markdown: string }).markdown)
				.join("\n");
			expect(replies).toContain("pelican-42");

			const second = open();
			await vi.waitFor(() =>
				expect(second.events.find((e) => e.type === "shell")).toMatchObject({
					command: "echo pelican-$((6*7))",
					output: "pelican-42\n",
					exitCode: 0,
					state: "done",
				}),
			);
			// The command stays outside any turn, and the typed question is its own turn.
			const shown = second.events.filter((e) =>
				["shell", "turn.started", "message"].includes(e.type),
			);
			expect(shown.map((e) => e.type).slice(0, 3)).toEqual([
				"shell",
				"turn.started",
				"message",
			]);
			second.socket.destroy();
		} finally {
			first.socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
			await removeSessionFolder(project);
		}
	},
	200_000,
);

test.skipIf(!existsSync(CLAUDE))(
	"a rename from the pencil survives a later turn, and /rename in the chat is read back",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "pk-chat-real-"));
		const project = join(home, "projects", "titles");
		await mkdir(project, { recursive: true });
		const titleId = "6a2d9e4b-1c3f-4a5e-8b7d-9c0e1f2a3b4c";
		const posted: (string | null)[] = [];
		const host = new ChatHost({
			terminalId: titleId,
			projectDir: project,
			homeDir: home,
			socketDir: join(home, "chat"),
			log: silentLogger(),
			postLimits: async () => undefined,
			postTitle: async (title) => {
				posted.push(title);
			},
			claudePath: CLAUDE,
		});
		await host.start();
		const socket = connect(host.socketPath);
		const events: ChatServerEvent[] = [];
		readLines(socket, 16 * 1024 * 1024, (line) => events.push(JSON.parse(line)));
		const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
		const finished = () => events.filter((e) => e.type === "turn.finished").length;
		const turn = async (text: string) => {
			const before = finished();
			send({ type: "send", text, attachments: [] });
			await vi.waitFor(() => expect(finished()).toBeGreaterThan(before), {
				timeout: 120_000,
				interval: 500,
			});
		};
		try {
			await vi.waitFor(() =>
				expect(events.some((e) => e.type === "snapshot")).toBe(true),
			);
			send({ type: "set", model: "haiku" });
			await turn("Reply with the single word: ready");
			// Claude Code's summary falls back to the first prompt.
			await vi.waitFor(() => expect(posted.at(-1)).toBeTruthy(), { timeout: 10_000 });

			send({ type: "rename", title: "Pelican plans" });
			await vi.waitFor(() => expect(posted.at(-1)).toBe("Pelican plans"), {
				timeout: 10_000,
			});
			await turn("Reply with the single word: again");
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(posted.at(-1)).toBe("Pelican plans");
			const info = await getSessionInfo(titleId, { dir: project });
			expect(info?.customTitle).toBe("Pelican plans");

			await turn("/rename Heron notes");
			await vi.waitFor(() => expect(posted.at(-1)).toBe("Heron notes"), {
				timeout: 10_000,
			});
		} finally {
			socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
			await removeSessionFolder(project);
		}
	},
	300_000,
);

/**
 * A subagent's own conversation reaches an attachment that watches its Agent
 * call, outside the chat's own events, and a later watch replays it from the
 * subagent's transcript (SPEC.md §10.8).
 */
test.skipIf(!existsSync(CLAUDE))(
	"a watched subagent's conversation streams to the watcher and replays from disk",
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
			postTitle: async () => undefined,
			claudePath: CLAUDE,
		});
		await host.start();
		const socket = connect(host.socketPath);
		const events: ChatServerEvent[] = [];
		const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
		readLines(socket, 16 * 1024 * 1024, (line) => {
			const event = JSON.parse(line) as ChatServerEvent;
			events.push(event);
			// Watch the subagent as soon as its Agent call shows.
			if (event.type === "tool.started" && event.name === "Agent") {
				send({ type: "subagent.watch", toolUseId: event.id });
			}
		});
		const subagentEvents = () =>
			events.flatMap((e) => (e.type === "subagent" ? [e.event] : []));
		try {
			await vi.waitFor(() =>
				expect(events.some((e) => e.type === "snapshot")).toBe(true),
			);
			send({ type: "set", model: "haiku", mode: "bypassPermissions" });
			send({
				type: "send",
				text: "Use the Agent tool once, with subagent_type general-purpose and the prompt: 'Run `echo hi` with the Bash tool, then reply with exactly the word sparrow.' Wait for it, then tell me its reply.",
				attachments: [],
			});
			await vi.waitFor(
				() => {
					const finished = subagentEvents().find((e) => e.type === "turn.finished");
					expect(finished).toBeTruthy();
				},
				{ timeout: 150_000, interval: 500 },
			);
			const watched = subagentEvents();
			expect(watched[0]?.type).toBe("snapshot");
			expect(watched.some((e) => e.type === "tool.started" && e.name === "Bash")).toBe(
				true,
			);
			const said = watched
				.filter((e) => e.type === "message" && e.role === "assistant")
				.map((e) => (e as { markdown: string }).markdown)
				.join(" ");
			expect(said.toLowerCase()).toContain("sparrow");
			// The subagent's Bash call never shows in the chat's own events.
			expect(events.some((e) => e.type === "tool.started" && e.name === "Bash")).toBe(
				false,
			);

			// A second attachment watching later gets the run from the transcript.
			const agentCall = events.find(
				(e) => e.type === "tool.started" && e.name === "Agent",
			);
			const late = connect(host.socketPath);
			const lateEvents: ChatServerEvent[] = [];
			readLines(late, 16 * 1024 * 1024, (line) => {
				lateEvents.push(JSON.parse(line) as ChatServerEvent);
			});
			try {
				late.write(
					`${JSON.stringify({ type: "subagent.watch", toolUseId: (agentCall as { id: string }).id })}\n`,
				);
				await vi.waitFor(
					() => {
						const replayed = lateEvents.flatMap((e) =>
							e.type === "subagent" ? [e.event] : [],
						);
						expect(replayed.at(-1)?.type).toBe("turn.finished");
						expect(
							replayed.some((e) => e.type === "message" && e.role === "user"),
						).toBe(true);
					},
					{ timeout: 30_000, interval: 200 },
				);
			} finally {
				late.destroy();
			}
		} finally {
			socket.destroy();
			await host.stop();
			await rm(home, { recursive: true, force: true });
			await removeSessionFolder(project);
		}
	},
	240_000,
);
