/**
 * Launcher argv, the session baseline, and the URL broker
 * (SPEC.md §10.2, §10.9, §12.7; BROWSER-HANDLING.md §18, §25.2).
 */
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { createLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { baselineDiff, baselineStatus, recordBaseline } from "./git.js";
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

async function tempRepo(
	name: string,
	objectFormat?: "sha256",
): Promise<{
	home: string;
	dir: string;
}> {
	const home = await mkdtemp(join(tmpdir(), `portikus-${name}-`));
	const dir = join(home, "projects", name);
	await mkdir(dir, { recursive: true });
	const init = ["init", "--initial-branch=main"];
	if (objectFormat) init.push(`--object-format=${objectFormat}`);
	await git(init, dir);
	await writeFile(join(dir, "tracked.txt"), "tracked\n");
	await git(["add", "tracked.txt"], dir);
	await git(["commit", "-m", "init"], dir);
	return { home, dir };
}

test("a clean repo gets a non-null baseline and git status is unchanged", async () => {
	const { home, dir } = await tempRepo("clean");
	try {
		const before = await snapshot(dir);
		const recorded = await recordBaseline(dir);
		expect(recorded.baselineObjectId).toMatch(/^[0-9a-f]{40}$/);
		expect(recorded.baselineHead).toBe(recorded.baselineObjectId);
		expect(await snapshot(dir)).toBe(before);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an untracked file from before the baseline is not a session addition", async () => {
	const { home, dir } = await tempRepo("untracked");
	try {
		await writeFile(join(dir, ".gitignore"), "node_modules\n.env\n.env.*\n");
		await git(["add", ".gitignore"], dir);
		await git(["commit", "-m", "ignore"], dir);
		await writeFile(join(dir, "already.txt"), "before\n");
		await writeFile(join(dir, ".env"), "SECRET=1\n");
		await mkdir(join(dir, "node_modules"), { recursive: true });
		await writeFile(join(dir, "node_modules", "pkg.js"), "x\n");
		const before = await snapshot(dir);
		const recorded = await recordBaseline(dir);
		const objectId = recorded.baselineObjectId;
		if (!objectId) throw new Error("expected a baseline");
		expect(await snapshot(dir)).toBe(before);
		const refs = await git(["show-ref"], dir);
		expect(refs).not.toContain("refs/stash");

		await writeFile(join(dir, "during.txt"), "after\n");
		const status = await baselineStatus(home, "untracked", objectId);
		const paths = status.entries.map((entry) => entry.path);
		expect(paths).not.toContain("already.txt");
		expect(paths).not.toContain(".env");
		expect(paths).not.toContain("node_modules/pkg.js");
		expect(paths).toContain("during.txt");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an edited pre-existing untracked file diffs against the second parent", async () => {
	const { home, dir } = await tempRepo("untracked-diff");
	try {
		await writeFile(join(dir, "already.txt"), "before\n");
		const recorded = await recordBaseline(dir);
		const objectId = recorded.baselineObjectId;
		if (!objectId) throw new Error("expected a baseline");

		await writeFile(join(dir, "already.txt"), "after\n");
		const edited = await baselineDiff(home, "untracked-diff", objectId, "already.txt");
		expect(edited.status).toBe("M");
		expect(edited.before).toBe("before\n");
		expect(edited.after).toBe("after\n");

		await rm(join(dir, "already.txt"));
		const removed = await baselineDiff(home, "untracked-diff", objectId, "already.txt");
		expect(removed.status).toBe("D");
		expect(removed.before).toBe("before\n");
		expect(removed.after).toBeNull();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a tracked root .env.example appears once after it is edited", async () => {
	const { home, dir } = await tempRepo("env-example");
	try {
		await writeFile(join(dir, ".env.example"), "A=1\n");
		await git(["add", ".env.example"], dir);
		await git(["commit", "-m", "example"], dir);
		const recorded = await recordBaseline(dir);
		const objectId = recorded.baselineObjectId;
		if (!objectId) throw new Error("expected a baseline");
		await writeFile(join(dir, ".env.example"), "A=2\n");
		const status = await baselineStatus(home, "env-example", objectId);
		const rows = status.entries.filter((entry) => entry.path === ".env.example");
		expect(rows).toEqual([{ path: ".env.example", x: ".", y: "M", unmerged: false }]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a pre-existing untracked symlink is not a session addition", async () => {
	const { home, dir } = await tempRepo("symlink");
	try {
		await symlink("/etc/hostname", join(dir, "outside.link"));
		const recorded = await recordBaseline(dir);
		const objectId = recorded.baselineObjectId;
		if (!objectId) throw new Error("expected a baseline");
		await symlink("tracked.txt", join(dir, "during.link"));
		const status = await baselineStatus(home, "symlink", objectId);
		const paths = status.entries.map((entry) => entry.path);
		expect(paths).not.toContain("outside.link");
		expect(paths).toContain("during.link");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a clean filter does not run while recording a baseline", async () => {
	const { home, dir } = await tempRepo("filter");
	try {
		const marker = join(dir, "filter-ran");
		const script = join(dir, "evil-filter.sh");
		await writeFile(
			script,
			`#!/bin/sh\necho ran >> '${marker}'\ngit update-ref refs/heads/pwned HEAD\ncat\n`,
			{ mode: 0o755 },
		);
		await git(["config", "filter.evil.clean", script], dir);
		await git(["config", "filter.evil.smudge", "cat"], dir);
		await writeFile(join(dir, ".gitattributes"), "tracked.txt filter=evil\n");
		await git(["add", ".gitattributes"], dir);
		await git(["commit", "-m", "attr"], dir);
		// Committing the attributes file runs the filter once. Clear that.
		await git(["update-ref", "-d", "refs/heads/pwned"], dir);
		await rm(marker, { force: true });
		await writeFile(join(dir, "tracked.txt"), "tracked\ndirty\n");
		const recorded = await recordBaseline(dir);
		expect(recorded.baselineObjectId).toMatch(/^[0-9a-f]{40}$/);
		await expect(stat(marker)).rejects.toThrow();
		await expect(
			git(["rev-parse", "--verify", "refs/heads/pwned"], dir),
		).rejects.toThrow();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a 64-character object id is accepted", async () => {
	const { home, dir } = await tempRepo("sha256", "sha256");
	try {
		const recorded = await recordBaseline(dir);
		expect(recorded.baselineObjectId).toMatch(/^[0-9a-f]{64}$/);
		const status = await baselineStatus(
			home,
			"sha256",
			recorded.baselineObjectId ?? "",
		);
		expect(status.repo).toBe(true);
		expect(status.entries).toEqual([]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	const missing = "ab".repeat(32);
	const response = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/baseline-status?object=${missing}`,
		headers: auth(),
	});
	expect(response.statusCode).not.toBe(400);
	expect(response.json()).toMatchObject({ error: { code: "GIT_FAILED" } });
});

test("a Node cmdline for codex is loopback-login", async () => {
	await waitForSocket();
	// Basename `codex`, but the process executable is Node.
	const script = join(homeDir, "codex");
	await writeFile(script, "setInterval(() => {}, 1000);\n");
	const nodeChild = spawn(process.execPath, [script], { stdio: "ignore" });
	try {
		expect(nodeChild.pid).toBeGreaterThan(0);
		const events = await openEvents();
		const requestId = "550e8400-e29b-41d4-a716-4466554400dd";
		const url = "http://127.0.0.1:43127/callback";
		const reply = await brokerRequest({
			requestId,
			url,
			executable: process.execPath,
			pid: nodeChild.pid,
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
		expect(frame).toMatchObject({ brokerClass: "loopback-login", url });
		await events.close();
	} finally {
		nodeChild.kill();
	}
});

test("a dropped frame is ok false", async () => {
	await waitForSocket();
	const outside = await brokerRequest({
		requestId: "550e8400-e29b-41d4-a716-4466554400e1",
		url: "https://example.com/login",
		executable: "claude",
		cwd: "/tmp",
	});
	expect(outside).toEqual({ ok: false, reason: "no-project" });
	expect(JSON.stringify(outside)).not.toContain("example.com");

	const quiet = await brokerRequest({
		requestId: "550e8400-e29b-41d4-a716-4466554400e2",
		url: "https://example.com/login",
		executable: "claude",
		cwd: project,
	});
	expect(quiet).toEqual({ ok: false, reason: "no-subscriber" });
	expect(JSON.stringify(quiet)).not.toContain("example.com");
});

function frameType(frame: unknown): string | undefined {
	if (typeof frame === "object" && frame !== null && "type" in frame) {
		return String((frame as { type: unknown }).type);
	}
	return undefined;
}
