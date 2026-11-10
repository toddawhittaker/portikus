/**
 * The hook and status-line scripts the coding agents run (SPEC.md §10.8):
 * they throw away what they must not read, never block or fail the agent,
 * and send only state words and limit numbers (ADR 0012).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const SUBAGENT_SCRIPT = fileURLToPath(
	new URL("../scripts/portikus-agent-subagent", import.meta.url),
);

/** What Claude Code hands an Agent hook: the prompt and the reply must never travel. */
const AGENT_HOOK_INPUT = JSON.stringify({
	session_id: "s1",
	transcript_path: "/home/student/.claude/projects/x.jsonl",
	cwd: "/home/student/secret-project",
	hook_event_name: "PostToolUse",
	tool_name: "Agent",
	tool_use_id: "toolu_01ABC",
	tool_input: {
		description: "Find the parser",
		prompt: "secret prompt",
		subagent_type: "Explore",
		run_in_background: true,
		model: "opus",
	},
	tool_response: {
		agentId: "agent-7",
		status: "async_launched",
		content: "secret reply",
	},
});

function subagentEnv(extra: Record<string, string> = {}) {
	return {
		PORTIKUS_TERMINAL: `pk-${TERMINAL_ID}`,
		PORTIKUS_AGENT_RECEIVER: receiverUrl,
		...extra,
	};
}

function parsedBody(): Record<string, unknown> {
	return JSON.parse(received[0]?.body ?? "{}") as Record<string, unknown>;
}

test("the subagent hook posts only the allow-listed fields of a tool call", async () => {
	const { code, stdout } = await run(
		SUBAGENT_SCRIPT,
		["post_tool_use"],
		AGENT_HOOK_INPUT,
		subagentEnv(),
	);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toHaveLength(1);
	expect(received[0]?.path).toBe("/coding-agent-subagent");
	const { at, ...rest } = parsedBody();
	expect(rest).toEqual({
		terminal: TERMINAL_ID,
		event: "post_tool_use",
		tool_use_id: "toolu_01ABC",
		description: "Find the parser",
		subagent_type: "Explore",
		run_in_background: true,
		agent_id: "agent-7",
	});
	expect(Math.abs(Number(at) / 1000 - Date.now())).toBeLessThan(10_000);
	expect(received[0]?.body).not.toContain("secret");
});

test("the subagent hook leaves out a missing or wrong-typed field and keeps the rest", async () => {
	const input = JSON.stringify({
		tool_use_id: "toolu_01ABC",
		tool_input: { description: { nested: "secret" }, prompt: "secret prompt" },
		tool_response: "secret reply",
	});
	await run(SUBAGENT_SCRIPT, ["pre_tool_use"], input, subagentEnv());
	const { at: _at, ...rest } = parsedBody();
	expect(rest).toEqual({
		terminal: TERMINAL_ID,
		event: "pre_tool_use",
		tool_use_id: "toolu_01ABC",
	});
});

test("SubagentStop sends only the agent id", async () => {
	const input = JSON.stringify({
		agent_id: "agent-7",
		agent_type: "Explore",
		last_assistant_message: "secret reply",
		tool_use_id: "toolu_01ABC",
	});
	await run(SUBAGENT_SCRIPT, ["subagent_stop"], input, subagentEnv());
	const { at: _at, ...rest } = parsedBody();
	expect(rest).toEqual({
		terminal: TERMINAL_ID,
		event: "subagent_stop",
		agent_id: "agent-7",
	});
});

test.each(["user_prompt_submit", "stop"])(
	"%s sends the event alone, never its prompt or reply",
	async (event) => {
		const input = JSON.stringify({
			prompt: "secret prompt",
			last_assistant_message: "secret",
		});
		const { code } = await run(SUBAGENT_SCRIPT, [event], input, subagentEnv());
		expect(code).toBe(0);
		const { at: _at, ...rest } = parsedBody();
		expect(rest).toEqual({ terminal: TERMINAL_ID, event });
	},
);

test("the subagent hook sends nothing for input that is not JSON, and exits 0", async () => {
	const { code } = await run(
		SUBAGENT_SCRIPT,
		["pre_tool_use"],
		"not json",
		subagentEnv(),
	);
	expect(code).toBe(0);
	expect(received).toHaveLength(0);
});

test("the subagent hook reads its whole input, so the agent's write never fails", async () => {
	const big = JSON.stringify({
		tool_use_id: "toolu_1",
		tool_input: { prompt: "x".repeat(1024 * 1024) },
	});
	const { code } = await run(SUBAGENT_SCRIPT, ["pre_tool_use"], big, subagentEnv());
	expect(code).toBe(0);
	expect(received).toHaveLength(1);
});

test("outside a Portikus terminal, or with an odd event, the subagent hook does nothing", async () => {
	for (const [args, env] of [
		[["pre_tool_use"], { PORTIKUS_AGENT_RECEIVER: receiverUrl }],
		[["pre-tool-use; rm"], subagentEnv()],
		[[], subagentEnv()],
	] as const) {
		const { code } = await run(SUBAGENT_SCRIPT, [...args], AGENT_HOOK_INPUT, env);
		expect(code).toBe(0);
	}
	expect(received).toHaveLength(0);
});

test("without jq the subagent hook exits 0 silently", async () => {
	const bin = mkdtempSync(join(tmpdir(), "no-jq-"));
	for (const tool of ["date", "cat", "curl", "timeout"]) {
		const found = execFileSync("bash", ["-c", `command -v ${tool}`])
			.toString()
			.trim();
		symlinkSync(found, join(bin, tool));
	}
	const { code, stdout } = await run(
		SUBAGENT_SCRIPT,
		["pre_tool_use"],
		AGENT_HOOK_INPUT,
		{
			...subagentEnv(),
			PATH: bin,
		},
	);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(received).toHaveLength(0);
});

test("the subagent hook exits 0 within its second when the receiver never answers", async () => {
	const silent = createServer(() => {});
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	try {
		const { code, ms } = await run(
			SUBAGENT_SCRIPT,
			["pre_tool_use"],
			AGENT_HOOK_INPUT,
			{
				...subagentEnv(),
				PORTIKUS_AGENT_RECEIVER: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
			},
		);
		expect(code).toBe(0);
		expect(ms).toBeLessThan(2500);
	} finally {
		silent.closeAllConnections();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	}
});
