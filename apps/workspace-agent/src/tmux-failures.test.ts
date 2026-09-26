/**
 * tmux failures that are not "no such session" (SPEC.md §9.7). A fake `tmux`
 * on PATH answers each command the way the test needs.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, hasSession, listSessions, tmuxServerGone } from "./tmux.js";

const server = { socketName: "fake", external: true };
const ID = "0b8c9a53-4c55-4b8e-9d0e-6f2a1b3c4d5e";
let dir: string;
let savedPath: string | undefined;

async function fakeTmux(body: string): Promise<void> {
	const file = join(dir, "tmux");
	await writeFile(file, `#!/bin/bash\necho "$*" >> "${dir}/calls"\n${body}\n`);
	await chmod(file, 0o755);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "fake-tmux-"));
	savedPath = process.env.PATH;
	process.env.PATH = `${dir}:${savedPath}`;
});

afterEach(async () => {
	process.env.PATH = savedPath;
	await rm(dir, { recursive: true, force: true });
});

describe("hasSession and listSessions", () => {
	it("answer false and empty only when the session or server is missing", async () => {
		await fakeTmux(`echo "can't find session: pk-x" >&2; exit 1`);
		expect(await hasSession(ID, server)).toBe(false);
		await fakeTmux(`echo "no server running on /tmp/tmux-1000/fake" >&2; exit 1`);
		expect(await listSessions(server)).toEqual([]);
	});

	it("rethrow any other failure as TMUX_FAILED", async () => {
		await fakeTmux(`echo "server exited unexpectedly" >&2; exit 1`);
		await expect(hasSession(ID, server)).rejects.toMatchObject({ code: "TMUX_FAILED" });
		await expect(listSessions(server)).rejects.toMatchObject({ code: "TMUX_FAILED" });
	});
});

describe("createSession", () => {
	it("kills the half-made session when a later step fails", async () => {
		await fakeTmux(`case "$*" in *set-option*) echo "boom" >&2; exit 1;; esac\nexit 0`);
		await expect(
			createSession(ID, dir, dir, "dark", "UTC", server),
		).rejects.toMatchObject({ code: "TMUX_FAILED" });
		const calls = await readFile(join(dir, "calls"), "utf8");
		expect(calls).toContain(`kill-session -t pk-${ID}`);
	});
});

describe("tmuxServerGone", () => {
	it("is true only when the external server is not there", async () => {
		await fakeTmux(`echo "no server running on /tmp/tmux-1000/fake" >&2; exit 1`);
		expect(await tmuxServerGone(server)).toBe(true);
		expect(await tmuxServerGone({ ...server, external: false })).toBe(false);
		await fakeTmux(`echo "server exited unexpectedly" >&2; exit 1`);
		expect(await tmuxServerGone(server)).toBe(false);
		await fakeTmux("exit 0");
		expect(await tmuxServerGone(server)).toBe(false);
	});
});
