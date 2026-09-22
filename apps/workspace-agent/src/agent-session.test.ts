/**
 * Launcher argv, the session baseline, and the URL broker
 * (SPEC.md §10.2, §10.9, §12.7; BROWSER-HANDLING.md §18, §25.2).
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { createLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { recordBaseline } from "./git.js";
import { buildServer } from "./server.js";
import { commandForAgent, createSession, killSession } from "./tmux.js";

const run = promisify(execFile);
const TOKEN = "d".repeat(64);
const SLUG = "demo";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440111";
const SECRET = "sk-ant-test-value";
const QUERY_SECRET = "sekrit-code";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

const haveTmux = await tmuxAvailable();
const SOCKET_NAME = `portikus-agent-${process.pid}`;

let homeDir: string;
let project: string;
let binDir: string;
let brokerPath: string;
let app: FastifyInstance;
let port: number;
let logText = "";
const savedPath = process.env.PATH;

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", args, {
		cwd,
		env: { ...process.env, ...GIT_ENV },
	});
	return stdout;
}

/** Porcelain, HEAD, and the stash ref: recording a baseline must not touch them. */
async function snapshot(cwd: string): Promise<string> {
	const porcelain = await git(["status", "--porcelain=v1"], cwd);
	const head = await git(["rev-parse", "HEAD"], cwd);
	let stash = "none";
	try {
		stash = (await git(["rev-parse", "--verify", "refs/stash"], cwd)).trim();
	} catch {
		stash = "none";
	}
	const cached = await git(["diff", "--cached", "--name-only"], cwd);
	return `${porcelain}\n${head}\n${stash}\n${cached}`;
}

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

beforeAll(async () => {
	Object.assign(process.env, GIT_ENV);
	homeDir = await mkdtemp(join(tmpdir(), "portikus-agent-"));
	project = join(homeDir, "projects", SLUG);
	await mkdir(project, { recursive: true });
	await git(["init", "--initial-branch=main"], project);
	await writeFile(join(project, "keep.txt"), "one\n");
	await git(["add", "keep.txt"], project);
	await git(["commit", "-m", "init"], project);
	await writeFile(join(project, "keep.txt"), "one\ntwo\n");

	binDir = join(homeDir, "bin");
	await mkdir(binDir);
	const shim = "#!/bin/sh\nexec sleep 60\n";
	await writeFile(join(binDir, "claude"), shim, { mode: 0o755 });
	await writeFile(join(binDir, "codex"), shim, { mode: 0o755 });
	await chmod(join(binDir, "claude"), 0o755);
	await chmod(join(binDir, "codex"), 0o755);
	process.env.PATH = `${binDir}:${savedPath ?? ""}`;

	brokerPath = `/tmp/pk-broker-${process.pid}.sock`;
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const chunks: Buffer[] = [];
	const destination = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			logText = Buffer.concat(chunks).toString("utf8");
			callback();
		},
	});
	app = buildServer({
		tokenPath,
		homeDir,
		tmuxSocketName: SOCKET_NAME,
		brokerSocketPath: brokerPath,
		workspaceId: WORKSPACE_ID,
		logger: createLogger({
			service: "workspace-agent",
			level: "debug",
			destination,
		}),
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
	process.env.PATH = savedPath;
	await app.close();
	if (haveTmux) {
		await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
	}
	await rm(homeDir, { recursive: true, force: true });
	await rm(brokerPath, { force: true }).catch(() => undefined);
});

test("the agent enum is the only argv", () => {
	expect(commandForAgent("claude")).toEqual(["claude"]);
	expect(commandForAgent("codex")).toEqual(["codex"]);
});

test.skipIf(!haveTmux)(
	"claude and codex become that argv, with institutional keys only on the session",
	async () => {
		const claudeId = "00000000-0000-4000-8000-000000009101";
		const created = await createSession(
			claudeId,
			project,
			homeDir,
			"dark",
			"Europe/Berlin",
			SOCKET_NAME,
			{
				command: commandForAgent("claude"),
				institutionalEnv: { ANTHROPIC_API_KEY: SECRET },
				recordBaseline,
			},
		);
		expect(created.baselineObjectId).toMatch(/^[0-9a-f]{40}$/);
		expect(created.baselineHead).toMatch(/^[0-9a-f]{40}$/);

		const { stdout: started } = await run("tmux", [
			"-L",
			SOCKET_NAME,
			"display-message",
			"-p",
			"-t",
			`pk-${claudeId}`,
			"#{pane_start_command}",
		]);
		expect(started.trim()).toBe("claude");

		const { stdout: key } = await run("tmux", [
			"-L",
			SOCKET_NAME,
			"show-environment",
			"-t",
			`pk-${claudeId}`,
			"ANTHROPIC_API_KEY",
		]);
		expect(key.trim()).toBe(`ANTHROPIC_API_KEY=${SECRET}`);
		await expect(
			run("tmux", [
				"-L",
				SOCKET_NAME,
				"show-environment",
				"-t",
				`pk-${claudeId}`,
				"OPENAI_API_KEY",
			]),
		).rejects.toThrow();
		expect(logText).not.toContain(SECRET);

		const codexId = "00000000-0000-4000-8000-000000009102";
		await createSession(
			codexId,
			project,
			homeDir,
			"dark",
			"Europe/Berlin",
			SOCKET_NAME,
			{ command: commandForAgent("codex"), recordBaseline },
		);
		const { stdout: codex } = await run("tmux", [
			"-L",
			SOCKET_NAME,
			"display-message",
			"-p",
			"-t",
			`pk-${codexId}`,
			"#{pane_start_command}",
		]);
		expect(codex.trim()).toBe("codex");
		await killSession(claudeId, SOCKET_NAME);
		await killSession(codexId, SOCKET_NAME);
	},
);

test("a dirty tree gets a baseline and git status is unchanged", async () => {
	const before = await snapshot(project);
	const recorded = await recordBaseline(project);
	expect(recorded.baselineObjectId).toMatch(/^[0-9a-f]{40}$/);
	expect(recorded.baselineHead).toMatch(/^[0-9a-f]{40}$/);
	expect(await snapshot(project)).toBe(before);

	const plain = await mkdtemp(join(tmpdir(), "portikus-norepo-"));
	try {
		expect(await recordBaseline(plain)).toEqual({
			baselineObjectId: null,
			baselineHead: null,
		});
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});

test("baseline routes compare the working tree with the object", async () => {
	const recorded = await recordBaseline(project);
	const objectId = recorded.baselineObjectId;
	if (!objectId) throw new Error("expected a baseline");
	await writeFile(join(project, "keep.txt"), "changed\n");
	await writeFile(join(project, "fresh.txt"), "new\n");

	const status = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/baseline-status?object=${objectId}`,
		headers: auth(),
	});
	expect(status.statusCode).toBe(200);
	const body = status.json();
	expect(body.repo).toBe(true);
	expect(body.branch).toBeNull();
	expect(body.upstream).toBeNull();
	expect(body.ahead).toBe(0);
	expect(body.behind).toBe(0);
	expect(body.conflicts).toBe(0);
	expect(body.entries).toEqual(
		expect.arrayContaining([
			{ path: "keep.txt", x: ".", y: "M", unmerged: false },
			{ path: "fresh.txt", x: ".", y: "?", unmerged: false },
		]),
	);

	const diff = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/baseline-diff?object=${objectId}&path=keep.txt`,
		headers: auth(),
	});
	expect(diff.statusCode).toBe(200);
	expect(diff.json()).toMatchObject({
		status: "M",
		before: "one\ntwo\n",
		after: "changed\n",
		binary: false,
		tooLarge: false,
	});

	// Put the tree back so later baseline reads stay about the same file.
	await writeFile(join(project, "keep.txt"), "one\ntwo\n");
	await rm(join(project, "fresh.txt"));
});

interface Sock {
	frames: unknown[];
	close: () => Promise<void>;
}

async function openEvents(): Promise<Sock> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/${SLUG}/events`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	} as unknown as string[]);
	const frames: unknown[] = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(event.data as string));
	});
	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});
	await new Promise<void>((resolve) => {
		ws.addEventListener("open", () => resolve(), { once: true });
	});
	await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
	return {
		frames,
		close: async () => {
			ws.close();
			await closed;
		},
	};
}

function brokerRequest(body: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(brokerPath);
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			const end = text.indexOf("\n");
			if (end === -1) return;
			socket.end();
			resolve(JSON.parse(text.slice(0, end)));
		});
		socket.on("error", reject);
		socket.write(`${JSON.stringify(body)}\n`);
	});
}

async function waitForSocket(): Promise<void> {
	await vi.waitFor(async () => {
		const info = await stat(brokerPath);
		expect(info.isSocket()).toBe(true);
		expect(info.mode & 0o777).toBe(0o600);
	});
}

test("a codex loopback URL is loopback-login and is not opened externally", async () => {
	await waitForSocket();
	const events = await openEvents();
	const requestId = "550e8400-e29b-41d4-a716-4466554400aa";
	const url = `http://127.0.0.1:43127/callback?code=${QUERY_SECRET}`;
	const reply = await brokerRequest({
		requestId,
		url,
		executable: "codex",
		cwd: project,
	});
	expect(reply).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(
			events.frames.filter((frame) => frameType(frame) === "browser.open.request"),
		).toHaveLength(1);
	});
	const frame = events.frames.find(
		(item) => frameType(item) === "browser.open.request",
	);
	expect(frame).toMatchObject({
		type: "browser.open.request",
		requestId,
		workspaceId: WORKSPACE_ID,
		url,
		brokerClass: "loopback-login",
	});
	expect(frame).not.toMatchObject({ brokerClass: "external" });
	expect(logText).not.toContain(QUERY_SECRET);
	expect(logText).not.toContain(url);
	await events.close();
});

test("a duplicate requestId is one frame", async () => {
	await waitForSocket();
	const events = await openEvents();
	const requestId = "550e8400-e29b-41d4-a716-4466554400bb";
	const body = {
		requestId,
		url: "https://example.com/login",
		executable: "claude",
		cwd: project,
	};
	expect(await brokerRequest(body)).toEqual({ ok: true });
	expect(await brokerRequest(body)).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(
			events.frames.filter((frame) => frameType(frame) === "browser.open.request"),
		).toHaveLength(1);
	});
	// Give a second delivery a moment, then count again.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(
		events.frames.filter((frame) => frameType(frame) === "browser.open.request"),
	).toHaveLength(1);
	const frame = events.frames.find(
		(item) => frameType(item) === "browser.open.request",
	);
	expect(frame).toMatchObject({ brokerClass: "external" });
	await events.close();
});

test("a javascript URL never produces a frame", async () => {
	await waitForSocket();
	const events = await openEvents();
	const before = events.frames.length;
	const reply = await brokerRequest({
		requestId: "550e8400-e29b-41d4-a716-4466554400cc",
		url: "javascript:alert(1)",
		executable: "codex",
		cwd: project,
	});
	expect(reply).toEqual({ ok: false, reason: "scheme" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(
		events.frames
			.slice(before)
			.some((frame) => frameType(frame) === "browser.open.request"),
	).toBe(false);
	await events.close();
});

function frameType(frame: unknown): string | undefined {
	if (typeof frame === "object" && frame !== null && "type" in frame) {
		return String((frame as { type: unknown }).type);
	}
	return undefined;
}
