import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import type { loadSession } from "@portikus/auth";
import { CloseCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	FAKE_ROOT_PROMPT,
	type FakeRootShell,
	startFakeRootShell,
} from "../testing/fake-root-shell.js";
import { encodeJsonFrame, FrameType } from "./frames.js";
import { connectRootShellHelper } from "./helper-client.js";
import {
	MAX_FAILED_CHECKS,
	pipeRootShell,
	type RootShellPipe,
	rootShellSessionValid,
	SESSION_CHECK_INTERVAL_MS,
} from "./pipe.js";

/**
 * The root-shell pipe (ADR 0051): browser frames of SPEC.md §9.7 in, helper
 * frames out, and a once-a-second check that the session is still a live
 * administrator's.
 */

const auth = vi.hoisted(() => ({
	loadSession: vi.fn(),
	sessionGate: vi.fn(),
}));
vi.mock("@portikus/auth", () => auth);

type AuthUser = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

const ADMIN: AuthUser = {
	id: "00000000-0000-4000-8000-000000000001",
	email: "carol@example.com",
	displayName: "Carol",
	role: "administrator",
	mustChangePassword: false,
	mustAcceptUse: false,
	secondFactor: null,
	secondFactorApplies: false,
};

/** Just enough of a browser WebSocket for the pipe. */
class FakeBrowser extends EventEmitter {
	readonly OPEN = 1;
	readyState = 1;
	bufferedAmount = 0;
	sent: Array<string | Buffer> = [];
	closeCode: number | null = null;

	send(data: string | Buffer): void {
		this.sent.push(data);
	}

	close(code: number): void {
		if (this.readyState !== this.OPEN) return;
		this.readyState = 3;
		this.closeCode = code;
		setImmediate(() => this.emit("close", code, Buffer.alloc(0)));
	}

	type(data: string): void {
		this.emit("message", Buffer.from(JSON.stringify({ type: "input", data })), false);
	}

	output(): string {
		return this.sent
			.filter((one): one is Buffer => Buffer.isBuffer(one))
			.map((one) => one.toString())
			.join("");
	}

	text(): string[] {
		return this.sent.filter((one): one is string => typeof one === "string");
	}
}

const log = { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
const db = {} as Kysely<Database>;

let fake: FakeRootShell;
let browser: FakeBrowser;
let pipe: RootShellPipe;
let helper: Socket;

async function until(found: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !found(); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(found()).toBe(true);
}

beforeEach(async () => {
	auth.loadSession.mockResolvedValue(ADMIN);
	auth.sessionGate.mockReturnValue(null);
	const dir = mkdtempSync(join(tmpdir(), "portikus-root-shell-"));
	fake = await startFakeRootShell(join(dir, "helper.sock"));
	vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "Date"] });
	helper = await connectRootShellHelper(fake.socketPath);
	helper.write(
		encodeJsonFrame(FrameType.OPEN, {
			shellId: "00000000-0000-4000-8000-000000000002",
			actorId: ADMIN.id,
			actorName: "Carol",
			address: "127.0.0.1",
			cols: 80,
			rows: 24,
		}),
	);
	browser = new FakeBrowser();
	pipe = pipeRootShell({
		db,
		socket: browser as unknown as WebSocket,
		helper,
		sessionToken: "token",
		shellId: "00000000-0000-4000-8000-000000000002",
		log,
	});
	await until(() => browser.output().includes(FAKE_ROOT_PROMPT));
});

afterEach(async () => {
	vi.useRealTimers();
	await fake.close();
});

test("input reaches the helper and its output comes back as binary frames", async () => {
	browser.type("whoami\r");
	await until(() => browser.output().includes("whoami\r\n"));
	expect(fake.connections[0]?.frames).toEqual(["input"]);
});

test("a resize becomes the helper's resize frame", async () => {
	browser.emit(
		"message",
		Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })),
		false,
	);
	await until(() => browser.output().includes("[resized 120x40]"));
});

test("a malformed or binary browser frame is refused and never reaches the helper", async () => {
	browser.emit("message", Buffer.from("not json"), false);
	browser.emit(
		"message",
		Buffer.from(JSON.stringify({ type: "resize", cols: 0 })),
		false,
	);
	browser.emit("message", Buffer.from("raw"), true);
	browser.emit(
		"message",
		Buffer.from(JSON.stringify({ type: "input", data: "x".repeat(65537) })),
		false,
	);
	expect(browser.text()).toEqual(
		Array(4).fill(JSON.stringify({ type: "error", code: "BAD_FRAME" })),
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(fake.connections[0]?.frames).toEqual([]);
});

test("closing the browser socket only hangs up: no end frame", async () => {
	browser.close(1000);
	expect(await pipe.done).toBe("client");
	await until(() => fake.connections[0]?.closed === true);
	expect(fake.connections[0]?.endReason).toBeNull();
});

test("the shell exiting tells the browser and closes it normally", async () => {
	browser.type("exit\r");
	expect(await pipe.done).toBe("exit");
	expect(browser.text()).toContain(JSON.stringify({ type: "exit" }));
	expect(browser.closeCode).toBe(1000);
});

test("stopping the API ends the shell as api_stopped, with no end frame", async () => {
	pipe.stop();
	expect(await pipe.done).toBe("api_stopped");
	expect(browser.closeCode).toBe(1001);
	expect(fake.connections[0]?.endReason).toBeNull();
});

const revocations: Array<[string, () => void]> = [
	[
		"sign-out, a disabled account or the 12-hour limit",
		() => auth.loadSession.mockResolvedValue(null),
	],
	[
		"demotion to student",
		() => auth.loadSession.mockResolvedValue({ ...ADMIN, role: "student" }),
	],
	[
		"demotion to instructor",
		() => auth.loadSession.mockResolvedValue({ ...ADMIN, role: "instructor" }),
	],
	[
		"a session gate such as an owed second factor",
		() => auth.sessionGate.mockReturnValue("verify"),
	],
];

for (const [why, revoke] of revocations) {
	test(`${why} ends the shell's session: end frame, input dropped, close 4401`, async () => {
		revoke();
		vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS + 10);
		await until(() => browser.closeCode !== null);
		expect(browser.closeCode).toBe(CloseCode.SESSION_ENDED);
		// Anything typed after revocation never reaches the shell.
		browser.type("after\r");
		expect(await pipe.done).toBe("session_ended");
		expect(fake.connections[0]?.endReason).toBe("session_ended");
		expect(fake.connections[0]?.frames).toEqual(["end"]);
	});
}

test("revocation is caught on the next keystroke once a second has passed", async () => {
	// The interval is never advanced, so only the per-frame check can fire.
	auth.loadSession.mockResolvedValue(null);
	await new Promise((resolve) => setTimeout(resolve, SESSION_CHECK_INTERVAL_MS + 50));
	browser.type("x");
	await until(() => browser.closeCode !== null);
	expect(browser.closeCode).toBe(CloseCode.SESSION_ENDED);
});

test("a failing database ends the shell only after about a minute of failed checks", async () => {
	auth.loadSession.mockRejectedValue(new Error("database down"));
	for (let i = 1; i < MAX_FAILED_CHECKS; i += 1) {
		await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS);
	}
	expect(browser.closeCode).toBeNull();
	await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS);
	await until(() => browser.closeCode !== null);
	// Only a hang-up: no end frame, so a tmux running pg_upgrade survives.
	expect(browser.closeCode).toBe(CloseCode.SERVER_ERROR);
	browser.type("after\r");
	expect(await pipe.done).toBe("session_ended");
	expect(fake.connections[0]?.endReason).toBeNull();
	expect(fake.connections[0]?.frames).toEqual([]);
});

test("revocation resumes a helper paused by a lagging browser before sending end", async () => {
	browser.bufferedAmount = 10 * 1024 * 1024;
	browser.type("x");
	await until(() => browser.output().endsWith("x"));
	expect(helper.isPaused()).toBe(true);
	// Whether the helper socket is still paused when the end frame goes out.
	const pausedAtWrite: boolean[] = [];
	const write = helper.write.bind(helper);
	helper.write = ((...args: Parameters<Socket["write"]>) => {
		pausedAtWrite.push(helper.isPaused());
		return write(...args);
	}) as Socket["write"];
	auth.loadSession.mockResolvedValue(null);
	vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS + 10);
	await until(() => browser.closeCode !== null);
	expect(browser.closeCode).toBe(CloseCode.SESSION_ENDED);
	expect(pausedAtWrite).toEqual([false]);
	// Well inside HELPER_CLOSE_TIMEOUT_MS: the paused socket was resumed, not destroyed.
	const late = new Promise((resolve) => setTimeout(() => resolve("late"), 1000));
	expect(await Promise.race([pipe.done, late])).toBe("session_ended");
	expect(fake.connections[0]?.endReason).toBe("session_ended");
});

test("one good check resets the failure count", async () => {
	auth.loadSession.mockRejectedValue(new Error("database down"));
	for (let i = 1; i < MAX_FAILED_CHECKS; i += 1) {
		await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS);
	}
	auth.loadSession.mockResolvedValueOnce(ADMIN);
	await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS);
	await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS * 5);
	expect(browser.closeCode).toBeNull();
	pipe.stop();
	await pipe.done;
});

test("only a live administrator's session may hold a root shell", async () => {
	expect(await rootShellSessionValid(db, null)).toBe(false);
	expect(await rootShellSessionValid(db, "token")).toBe(true);
	auth.loadSession.mockResolvedValue({ ...ADMIN, role: "student" });
	expect(await rootShellSessionValid(db, "token")).toBe(false);
	pipe.stop();
	await pipe.done;
});
