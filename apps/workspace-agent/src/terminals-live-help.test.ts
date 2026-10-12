/**
 * Live-help attachments against a real tmux server and real PTYs (SPEC.md
 * §9.7): a viewer cannot type, a typing helper can, neither sizes the
 * student's window, a helper gets no history and does get size frames.
 */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "@fastify/websocket";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import { spawn } from "node-pty";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type AttachOptions, TerminalRegistry } from "./terminals.js";
import { attachArgs, createSession, killSession, sessionName } from "./tmux.js";

const run = promisify(execFile);
const SOCKET_NAME = `portikus-livehelp-${process.pid}`;
const SERVER = { socketName: SOCKET_NAME, external: false };

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

const haveTmux = await tmuxAvailable();

/** Just enough of an open WebSocket for the registry and the pane poll. */
class FakeSocket {
	readonly OPEN = 1;
	readyState = 1;
	bufferedAmount = 0;
	readonly sent: (string | Buffer)[] = [];
	private readonly handlers = new Map<string, ((arg: unknown) => void)[]>();

	on(event: string, handler: (arg: unknown) => void) {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return this;
	}
	send(data: string | Buffer) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
		this.fire("close", undefined);
	}
	fire(event: string, arg: unknown) {
		for (const handler of this.handlers.get(event) ?? []) handler(arg);
	}
	input(data: string) {
		this.fire("message", Buffer.from(JSON.stringify({ type: "input", data })));
	}
	resize(cols: number, rows: number) {
		this.fire("message", Buffer.from(JSON.stringify({ type: "resize", cols, rows })));
	}
	frames(type: string): Record<string, unknown>[] {
		return this.sent
			.filter((frame): frame is string => typeof frame === "string")
			.map((frame) => JSON.parse(frame) as Record<string, unknown>)
			.filter((frame) => frame.type === type);
	}
	binary(): string {
		return this.sent
			.filter((frame): frame is Buffer => typeof frame !== "string")
			.map((frame) => frame.toString("utf8"))
			.join("");
	}
}

let homeDir: string;
let registry: TerminalRegistry;
let nextId = 0;

function makeId(): string {
	nextId += 1;
	return `00000000-0000-4000-8000-${String(2000 + nextId)}00000000`;
}

async function display(id: string, format: string): Promise<string> {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"display-message",
		"-p",
		"-t",
		sessionName(id),
		format,
	]);
	return stdout.trim();
}

async function windowSize(id: string): Promise<string> {
	return display(id, "#{window_width}x#{window_height}");
}

async function screen(id: string): Promise<string> {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"capture-pane",
		"-p",
		"-t",
		sessionName(id),
	]);
	return stdout;
}

async function newTerminal(): Promise<string> {
	const id = makeId();
	await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
	return id;
}

/** Attach and wait until tmux has drawn, so input reaches a ready client. */
async function attach(id: string, options: AttachOptions): Promise<FakeSocket> {
	const socket = new FakeSocket();
	await registry.attach(id, socket as unknown as WebSocket, options);
	await vi.waitFor(() => expect(socket.binary().length).toBeGreaterThan(0), {
		timeout: 5000,
	});
	await new Promise((resolve) => setTimeout(resolve, 600));
	return socket;
}

beforeAll(async () => {
	if (!haveTmux) return;
	homeDir = await mkdtemp(join(tmpdir(), "portikus-livehelp-"));
	const { logger } = collectingLogger();
	registry = new TerminalRegistry(
		homeDir,
		logger as unknown as FastifyBaseLogger,
		SERVER,
	);
});

afterAll(async () => {
	if (!haveTmux) return;
	registry.closeEverything();
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

test("attachArgs adds tmux client flags only for helpers", () => {
	const server = { socketName: "s", external: true };
	const id = "00000000-0000-4000-8000-000000000001";
	expect(attachArgs(id, server).slice(-2)).toEqual(["-t", sessionName(id)]);
	expect(attachArgs(id, server, "view").slice(-2)).toEqual([
		"-f",
		"read-only,ignore-size",
	]);
	expect(attachArgs(id, server, "type").slice(-2)).toEqual(["-f", "ignore-size"]);
});

test.skipIf(!haveTmux)("tmux itself refuses a view client's keys", async () => {
	const id = await newTerminal();
	const pty = spawn("tmux", attachArgs(id, SERVER, "view"), {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: homeDir,
		env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
	});
	await new Promise((resolve) => setTimeout(resolve, 600));
	pty.write("echo tmux-viewer-typed\r");
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(await screen(id)).not.toContain("tmux-viewer-typed");
	pty.kill();
	await killSession(id, SERVER);
});

test.skipIf(!haveTmux)("a view attach cannot write or resize", async () => {
	const id = await newTerminal();
	const student = await attach(id, { cols: 100, rows: 30 });
	expect(await windowSize(id)).toBe("100x30");

	const viewer = await attach(id, { cols: 150, rows: 50, mode: "view" });
	viewer.input("echo viewer-typed\r");
	viewer.resize(60, 20);
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(await screen(id)).not.toContain("viewer-typed");
	expect(await windowSize(id)).toBe("100x30");

	viewer.close();
	student.close();
	await killSession(id, SERVER);
});

test.skipIf(!haveTmux)("a type attach can write but not resize", async () => {
	const id = await newTerminal();
	const student = await attach(id, { cols: 100, rows: 30 });

	const helper = await attach(id, { cols: 150, rows: 50, mode: "type" });
	helper.input("echo helper-$((40+2))\r");
	helper.resize(60, 20);
	await vi.waitFor(async () => expect(await screen(id)).toContain("helper-42"), {
		timeout: 5000,
	});
	expect(await windowSize(id)).toBe("100x30");

	helper.close();
	student.close();
	await killSession(id, SERVER);
});

test.skipIf(!haveTmux)("a helper gets no history, a student does", async () => {
	const id = await newTerminal();
	await run("tmux", [
		"-L",
		SOCKET_NAME,
		"send-keys",
		"-t",
		sessionName(id),
		"for i in $(seq 1 200); do echo history-line-$i; done",
		"Enter",
	]);
	await vi.waitFor(
		async () => expect(Number(await display(id, "#{history_size}"))).toBeGreaterThan(0),
		{ timeout: 5000 },
	);

	const student = await attach(id, {});
	expect(student.binary()).toContain("history-line-1\r\n");

	const helper = await attach(id, { mode: "view" });
	expect(helper.binary()).not.toContain("history-line-1\r\n");

	helper.close();
	student.close();
	await killSession(id, SERVER);
});

test.skipIf(!haveTmux)(
	"a helper gets the window size on attach and on change; a student does not",
	async () => {
		const id = await newTerminal();
		const student = await attach(id, { cols: 100, rows: 30 });
		const helper = await attach(id, { cols: 150, rows: 50, mode: "view" });

		await vi.waitFor(
			() =>
				expect(helper.frames("size")).toEqual([{ type: "size", cols: 100, rows: 30 }]),
			{ timeout: 5000 },
		);

		student.resize(120, 40);
		await vi.waitFor(
			() =>
				expect(helper.frames("size").at(-1)).toEqual({
					type: "size",
					cols: 120,
					rows: 40,
				}),
			{ timeout: 5000 },
		);
		expect(await windowSize(id)).toBe("120x40");
		expect(student.frames("size")).toEqual([]);

		helper.close();
		student.close();
		await killSession(id, SERVER);
	},
);
