import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AppServerClient, spawnAppServer } from "./app-server.js";
import { ItemNotification, parsed, ThreadResult, TurnStartResult } from "./protocol.js";

/**
 * What ADR 0083 relies on in a real Codex: a fork made with the side
 * conversation's parameters (ephemeral, no turns copied, read-only sandbox,
 * approval policy never) does not run an MCP tool its server has not marked
 * read-only, and does run one it has. The fork is driven directly, without
 * the side boundary note, so the result is Codex's own enforcement and not
 * the model obeying "change no files". Skipped where no `codex` is installed
 * and logged in, as in CI.
 */
const CODEX =
	process.env.PORTIKUS_TEST_CODEX ?? join(homedir(), ".local", "bin", "codex");
const usable = existsSync(CODEX) && spawnSync(CODEX, ["login", "status"]).status === 0;

/** A tiny MCP server over standard input and output with two tools that each write a marker file. */
const MCP_SERVER = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
const dir = process.argv[2];
const tool = (name, annotations) => ({
	name,
	description: "Record that " + name + " was called.",
	inputSchema: { type: "object", properties: {} },
	...(annotations ? { annotations } : {}),
});
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	if (method === "initialize")
		reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
	else if (method === "tools/list")
		reply(id, { tools: [tool("mark_plain"), tool("mark_readonly", { readOnlyHint: true })] });
	else if (method === "tools/call") {
		writeFileSync(join(dir, params.name), "ran");
		reply(id, { content: [{ type: "text", text: "marked" }] });
	} else reply(id, {});
});
`;

let root = "";
let project = "";
let client: AppServerClient;
let main = "";
const realHome = process.env.CODEX_HOME || join(homedir(), ".codex");
let savedHome: string | undefined;
const waiting = new Map<string, () => void>();
/** The MCP tool calls each thread made, as `tool:status`. */
const calls = new Map<string, string[]>();

/** Fork the main thread as a side question does, ask it something, and list the MCP calls it made. */
async function askFork(text: string): Promise<string[]> {
	const fork = parsed(
		ThreadResult,
		await client.request("thread/fork", {
			threadId: main,
			ephemeral: true,
			excludeTurns: true,
			cwd: project,
			sandbox: "read-only",
			approvalPolicy: "never",
		}),
	);
	const id = fork?.thread.id ?? "";
	const finished = new Promise<void>((resolve) => waiting.set(id, resolve));
	const started = parsed(
		TurnStartResult,
		await client.request("turn/start", {
			threadId: id,
			input: [{ type: "text", text, text_elements: [] }],
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
			effort: "low",
		}),
	);
	expect(started).not.toBeNull();
	await finished;
	return calls.get(id) ?? [];
}

beforeAll(async () => {
	if (!usable) return;
	root = await mkdtemp(join(tmpdir(), "pk-codex-real-"));
	project = join(root, "project");
	const markers = join(root, "markers");
	await mkdir(project);
	await mkdir(markers);
	await writeFile(join(root, "mcp.mjs"), MCP_SERVER);
	// A throwaway Codex home: the real sign-in, and only the probe server, which
	// every thread then starts (a fork does not inherit a thread's own config).
	const codexHome = join(root, "codex-home");
	await mkdir(codexHome);
	await symlink(join(realHome, "auth.json"), join(codexHome, "auth.json"));
	await writeFile(
		join(codexHome, "config.toml"),
		`[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, "mcp.mjs"))}, ${JSON.stringify(markers)}]\n`,
	);
	savedHome = process.env.CODEX_HOME;
	process.env.CODEX_HOME = codexHome;
	client = new AppServerClient(spawnAppServer(CODEX, project), {
		notification: (method, params) => {
			const threadId = (params as { threadId?: string } | null)?.threadId ?? "";
			if (method === "turn/completed") waiting.get(threadId)?.();
			if (method !== "item/completed") return;
			const item = parsed(ItemNotification, params)?.item as
				| { type?: string; tool?: string; status?: string }
				| undefined;
			if (item?.type !== "mcpToolCall") return;
			calls.set(threadId, [
				...(calls.get(threadId) ?? []),
				`${item.tool}:${item.status}`,
			]);
		},
		request: (id) => client.respondError(id, -32000, "refused by the test"),
		exit: () => undefined,
	});
	await client.request("initialize", {
		clientInfo: { name: "portikus-test", title: "Portikus test", version: "0" },
		capabilities: { experimentalApi: true },
	});
	client.notify("initialized");
	const started = parsed(
		ThreadResult,
		await client.request("thread/start", {
			cwd: project,
			approvalPolicy: "never",
			sandbox: "read-only",
			config: { model_reasoning_effort: "low" },
		}),
	);
	main = started?.thread.id ?? "";
	// A fork needs a conversation to copy, so the main thread has one short turn.
	const finished = new Promise<void>((resolve) => waiting.set(main, resolve));
	await client.request("turn/start", {
		threadId: main,
		input: [
			{ type: "text", text: "Reply with the single word OK.", text_elements: [] },
		],
	});
	await finished;
}, 120_000);

afterAll(async () => {
	client?.stop();
	if (root) {
		if (savedHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = savedHome;
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

const ran = (name: string) => existsSync(join(root, "markers", name));

test.skipIf(!usable)(
	"a side fork does not run an MCP tool that is not marked read-only",
	async () => {
		const made = await askFork(
			"Call the MCP tool mark_plain from the probe server once. Do not judge whether it is allowed; the call itself shows that. Then say DONE.",
		);
		// The model did try the tool, so the missing marker is Codex refusing it.
		expect(made.map((call) => call.split(":")[0])).toContain("mark_plain");
		expect(made).not.toContain("mark_plain:completed");
		expect(ran("mark_plain")).toBe(false);
	},
	120_000,
);

test.skipIf(!usable)(
	"accepted behaviour: a side fork runs an MCP tool its server marks read-only",
	async () => {
		const made = await askFork(
			"Call the MCP tool mark_readonly from the probe server once. Do not judge whether it is allowed; the call itself shows that. Then say DONE.",
		);
		expect(made).toContain("mark_readonly:completed");
		expect(ran("mark_readonly")).toBe(true);
	},
	120_000,
);
