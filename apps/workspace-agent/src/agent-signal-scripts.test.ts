/**
 * The hook and status-line scripts the coding agents run (SPEC.md §10.8):
 * they throw away what they must not read, never block or fail the agent,
 * and send only state words and limit numbers (ADR 0012).
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";

const STATE_SCRIPT = fileURLToPath(
	new URL("../scripts/portikus-agent-state", import.meta.url),
);
const STATUS_SCRIPT = fileURLToPath(
	new URL("../scripts/portikus-claude-status", import.meta.url),
);
const TERMINAL_ID = "4f7d2a8e-3b1c-4d5e-9f60-718293a4b5c6";

interface Received {
	path: string | undefined;
	body: string;
}

let server: Server;
let received: Received[];
let receiverUrl: string;

beforeEach(async () => {
	received = [];
	server = createServer((request: IncomingMessage, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			received.push({ path: request.url, body });
			response.writeHead(204).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(
	script: string,
	args: string[],
	input: string,
	env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; ms: number }> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(script, args, {
			env: { PATH: process.env.PATH, TZ: "UTC", ...env },
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const SECRET_INPUT = JSON.stringify({
	prompt: "secret prompt",
	tool_input: { command: "cat ~/.ssh/id_rsa" },
	cwd: "/home/student/secret-project",
});

test("a hook posts only the terminal id, the agent and the state", async () => {
	const { code, stdout } = await run(
		STATE_SCRIPT,
		["claude", "needs-input"],
		SECRET_INPUT,
		{
			PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
			PORTIKUS_AGENT_RECEIVER: receiverUrl,
		},
	);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toHaveLength(1);
	expect(received[0]?.path).toBe("/coding-agent-state");
	const body = received[0]?.body ?? "";
	const at = /"at":(\d+)}$/.exec(body)?.[1] ?? "";
	expect(body).toBe(
		JSON.stringify({
			terminal: TERMINAL_ID,
			agent: "claude",
			state: "needs-input",
		}).replace(/}$/, `,"at":${at}}`),
	);
	// Microseconds since the epoch, taken when the hook ran. The wall clock
	// can be stepped back while the test runs, so a reading a little ahead of
	// Date.now() is still right; milliseconds or nanoseconds would be off by
	// a factor of a thousand.
	const atMs = Number(BigInt(at) / 1000n);
	expect(Math.abs(atMs - Date.now())).toBeLessThan(10_000);
});

test("a hook reads its whole input, so the agent's write never fails", async () => {
	const big = "x".repeat(1024 * 1024);
	const { code } = await run(STATE_SCRIPT, ["codex", "working"], big, {
		PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
	});
	expect(code).toBe(0);
	expect(received).toHaveLength(1);
});

test("outside a Portikus terminal a hook does nothing", async () => {
	const { code } = await run(STATE_SCRIPT, ["claude", "working"], SECRET_INPUT, {
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
	});
	expect(code).toBe(0);
	expect(received).toEqual([]);
});

test("a hook refuses odd words rather than building a body from them", async () => {
	const { code } = await run(STATE_SCRIPT, ["claude", 'working","x":"y'], "", {
		PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
	});
	expect(code).toBe(0);
	expect(received).toEqual([]);
});

test("a hook exits 0 at once when the receiver is down", async () => {
	const { code, ms } = await run(STATE_SCRIPT, ["claude", "finished"], "", {
		PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
		PORTIKUS_AGENT_RECEIVER: "http://127.0.0.1:1",
	});
	expect(code).toBe(0);
	expect(ms).toBeLessThan(1500);
});

test("a hook exits 0 within its second when the receiver never answers", async () => {
	const held: Socket[] = [];
	const silent = createServer(() => {});
	silent.on("connection", (socket) => held.push(socket));
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	try {
		const { code, ms } = await run(STATE_SCRIPT, ["claude", "finished"], "", {
			PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
			PORTIKUS_AGENT_RECEIVER: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
		});
		expect(code).toBe(0);
		expect(ms).toBeLessThan(1500);
		expect(held.length).toBeGreaterThan(0);
	} finally {
		for (const socket of held) socket.destroy();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	}
});

const STATUS_INPUT = JSON.stringify({
	cwd: "/home/student/secret-project",
	model: { id: "claude-secret-model", display_name: "Secret" },
	cost: { total_cost_usd: 1.23 },
	transcript_path: "/home/student/.claude/projects/secret.jsonl",
	rate_limits: {
		five_hour: { used_percentage: 42.4, resets_at: 1_800_000_000, extra: "drop" },
		seven_day: { used_percentage: 18, resets_at: 1_800_300_000 },
		other: { used_percentage: 99 },
	},
});

test("the status line sends and prints only the two limit windows", async () => {
	const { code, stdout } = await run(STATUS_SCRIPT, [], STATUS_INPUT, {
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
	});
	expect(code).toBe(0);
	// 1_800_000_000 is 2027-01-15 08:00 UTC.
	expect(stdout.trim()).toBe("5h 42% · resets 8:00 am  7d 18%");
	expect(received).toHaveLength(1);
	expect(received[0]?.path).toBe("/claude-limits");
	expect(JSON.parse(received[0]?.body ?? "")).toEqual({
		five_hour: { used_percentage: 42.4, resets_at: 1_800_000_000 },
		seven_day: { used_percentage: 18, resets_at: 1_800_300_000 },
	});
	for (const secret of ["secret", "1.23", "transcript"]) {
		expect(received[0]?.body).not.toContain(secret);
		expect(stdout).not.toContain(secret);
	}
});

test("without rate limits the status line prints and sends nothing", async () => {
	const { code, stdout } = await run(
		STATUS_SCRIPT,
		[],
		JSON.stringify({ cwd: "/x", model: { id: "m" } }),
		{ PORTIKUS_AGENT_RECEIVER: receiverUrl },
	);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toEqual([]);
});

test("the status line still prints, and exits 0, when the receiver is down", async () => {
	const { code, stdout } = await run(STATUS_SCRIPT, [], STATUS_INPUT, {
		PORTIKUS_AGENT_RECEIVER: "http://127.0.0.1:1",
	});
	expect(code).toBe(0);
	expect(stdout).toContain("7d 18%");
});

test("input that is not JSON prints nothing and exits 0", async () => {
	const { code, stdout } = await run(STATUS_SCRIPT, [], "not json", {
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
	});
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toEqual([]);
});

test("a window with a null or non-numeric value is dropped, the good one kept", async () => {
	for (const bad of [
		{ used_percentage: null, resets_at: 1_800_000_000 },
		{ used_percentage: 42, resets_at: null },
		{ used_percentage: "42", resets_at: 1_800_000_000 },
		{ used_percentage: 42, resets_at: "soon" },
		{ resets_at: 1_800_000_000 },
	]) {
		received = [];
		const { code, stdout } = await run(
			STATUS_SCRIPT,
			[],
			JSON.stringify({
				rate_limits: {
					five_hour: bad,
					seven_day: { used_percentage: 18, resets_at: 1_800_300_000 },
				},
			}),
			{ PORTIKUS_AGENT_RECEIVER: receiverUrl },
		);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("7d 18%");
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0]?.body ?? "")).toEqual({
			seven_day: { used_percentage: 18, resets_at: 1_800_300_000 },
		});
	}
});

test("when every window is bad the status line prints and sends nothing", async () => {
	const { code, stdout } = await run(
		STATUS_SCRIPT,
		[],
		JSON.stringify({
			rate_limits: { five_hour: { used_percentage: null, resets_at: null } },
		}),
		{ PORTIKUS_AGENT_RECEIVER: receiverUrl },
	);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toEqual([]);
});
