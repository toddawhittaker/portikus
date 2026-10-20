/**
 * The language-server socket starts nothing outside this workspace's own
 * projects (SPEC.md §13.6, §24.6): a traversal, a symlinked project and
 * another workspace's slug are all refused before any server runs.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloseCode } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../server.js";
import { initializeRequest, openLspSocket } from "../test-support/lsp-socket.js";

const TOKEN = "d".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let otherHome: string;
let port: number;

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-lsp-sec-"));
	otherHome = await mkdtemp(join(tmpdir(), "portikus-lsp-other-"));
	await mkdir(join(homeDir, "projects", "alpha"), { recursive: true });
	await mkdir(join(homeDir, "outside"), { recursive: true });
	await symlink(join(homeDir, "outside"), join(homeDir, "projects", "linked"));
	await symlink(
		join(homeDir, "projects", "alpha"),
		join(homeDir, "projects", "sibling"),
	);
	await mkdir(join(otherHome, "projects", "theirs"), { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
	await rm(otherHome, { recursive: true, force: true });
});

async function closeFor(slug: string): Promise<number> {
	const socket = await openLspSocket(
		`ws://127.0.0.1:${port}/projects/${slug}/language-servers/python`,
		TOKEN,
	);
	// Sent anyway: a refused socket must not start a server for it.
	if (socket.ws.readyState === WebSocket.OPEN) socket.send(initializeRequest());
	const { code } = await socket.closed;
	expect(socket.frames).toEqual([]);
	return code;
}

test("a traversal in the slug is refused", async () => {
	// Refused at the upgrade (1006 to the client) or by the slug check.
	const refused = [CloseCode.POLICY, 1006];
	expect(refused).toContain(await closeFor("..%2Foutside"));
	expect(refused).toContain(await closeFor("%2E%2E"));
	expect(refused).toContain(await closeFor(".."));
});

test("a project that is a symlink out of ~/projects is refused", async () => {
	expect(await closeFor("linked")).toBe(CloseCode.POLICY);
});

test("a project that is a symlink to a sibling is refused", async () => {
	expect(await closeFor("sibling")).toBe(CloseCode.POLICY);
});

test("another workspace's project is not found here", async () => {
	expect(await closeFor("theirs")).toBe(CloseCode.NOT_FOUND);
});

test("the socket needs this workspace's token", async () => {
	const socket = await openLspSocket(
		`ws://127.0.0.1:${port}/projects/alpha/language-servers/python`,
		"e".repeat(64),
	);
	await socket.closed;
	expect(socket.frames).toEqual([]);
});
