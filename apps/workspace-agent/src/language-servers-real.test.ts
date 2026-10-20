/**
 * The real servers through the agent's socket (SPEC.md §13.6): pyright with
 * pushed diagnostics, and TypeScript 7's native server with pulled ones.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildServer } from "./server.js";
import {
	initializeRequest,
	type LspSocket,
	openLspSocket,
} from "./test-support/lsp-socket.js";
import { userTaskCount } from "./test-support/user-tasks.js";

const run = promisify(execFile);
const TOKEN = "f".repeat(64);
const SLOW = 30_000;

let app: FastifyInstance;
let homeDir: string;
let port: number;

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-lsp-real-"));
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir,
		languageServerMaxProcesses: (await userTaskCount()) + 2000,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

/** Opens, answers the server's own requests as a plain client would, and initializes. */
async function session(
	slug: string,
	server: string,
	capabilities: unknown,
): Promise<LspSocket> {
	const socket = await openLspSocket(
		`ws://127.0.0.1:${port}/projects/${slug}/language-servers/${server}`,
		TOKEN,
	);
	socket.ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data as string) as {
			id?: unknown;
			method?: string;
			params?: { items?: unknown[] };
		};
		if (message.id === undefined || message.method === undefined) return;
		const result =
			message.method === "workspace/configuration"
				? (message.params?.items ?? []).map(() => null)
				: null;
		socket.send({ jsonrpc: "2.0", id: message.id, result });
	});
	socket.send(initializeRequest({ capabilities }));
	await socket.response(1, SLOW);
	socket.send({ jsonrpc: "2.0", method: "initialized", params: {} });
	return socket;
}

function open(socket: LspSocket, uri: string, languageId: string, text: string): void {
	socket.send({
		jsonrpc: "2.0",
		method: "textDocument/didOpen",
		params: { textDocument: { uri, languageId, version: 1, text } },
	});
}

function labels(result: unknown): string[] {
	const items = Array.isArray(result) ? result : (result as { items: unknown[] }).items;
	return (items as Array<{ label: string }>).map((item) => item.label);
}

describe("pyright", () => {
	test(
		"completion, hover, pushed diagnostics, and imports from the project's .venv",
		async () => {
			const project = join(homeDir, "projects", "py");
			await mkdir(project, { recursive: true });
			await run("python3", ["-m", "venv", "--without-pip", join(project, ".venv")]);
			const lib = join(project, ".venv", "lib");
			const python = (await readdir(lib))[0] as string;
			const pkg = join(lib, python, "site-packages", "studentpkg");
			await mkdir(pkg, { recursive: true });
			await writeFile(join(pkg, "__init__.py"), "def greet() -> int:\n    return 1\n");

			const socket = await session("py", "python", {
				textDocument: {
					publishDiagnostics: {},
					hover: { contentFormat: ["markdown"] },
				},
				workspace: { configuration: true },
			});
			const uri = pathToFileURL(join(project, "main.py")).href;
			open(
				socket,
				uri,
				"python",
				'import studentpkg\nimport missingpkg\nvalue: int = "text"\nstudentpkg.gr\n',
			);

			const diagnostics = await socket.frame(
				(frame) =>
					frame.method === "textDocument/publishDiagnostics" &&
					(frame.params as { uri: string }).uri === uri &&
					(frame.params as { diagnostics: unknown[] }).diagnostics.length > 0,
				SLOW,
			);
			const messages = (
				diagnostics.params as { diagnostics: Array<{ message: string }> }
			).diagnostics
				.map((one) => one.message)
				.join("\n");
			expect(messages).toContain('"missingpkg" could not be resolved');
			expect(messages).not.toContain('"studentpkg" could not be resolved');
			expect(messages).toMatch(
				/"Literal\['text'\]" is not assignable to (declared type )?"int"/,
			);

			socket.send({
				jsonrpc: "2.0",
				id: 2,
				method: "textDocument/completion",
				params: { textDocument: { uri }, position: { line: 3, character: 13 } },
			});
			expect(labels((await socket.response(2, SLOW)).result)).toContain("greet");

			socket.send({
				jsonrpc: "2.0",
				id: 3,
				method: "textDocument/hover",
				params: { textDocument: { uri }, position: { line: 0, character: 9 } },
			});
			const hover = (await socket.response(3, SLOW)).result as {
				contents: { value: string };
			};
			expect(hover.contents.value).toContain("studentpkg");
			socket.ws.close();
		},
		SLOW * 2,
	);
});

describe("typescript", () => {
	test(
		"completion, hover and pulled diagnostics from the native server",
		async () => {
			const project = join(homeDir, "projects", "ts");
			await mkdir(project, { recursive: true });
			await writeFile(
				join(project, "tsconfig.json"),
				'{"compilerOptions":{"strict":true}}',
			);
			const socket = await session("ts", "typescript", {
				textDocument: {
					diagnostic: {},
					hover: { contentFormat: ["markdown"] },
					completion: {},
				},
			});
			// The agent took away the browser's configuration answer, so the
			// server must not ask for one.
			const initialized = socket.frames.find((frame) => frame.id === 1) as {
				result: {
					serverInfo?: { name: string };
					capabilities: Record<string, unknown>;
				};
			};
			expect(initialized.result.serverInfo?.name).toBe("typescript-go");
			for (const capability of [
				"completionProvider",
				"hoverProvider",
				"definitionProvider",
				"renameProvider",
				"documentFormattingProvider",
				"diagnosticProvider",
			]) {
				expect(initialized.result.capabilities[capability]).toBeTruthy();
			}

			const uri = pathToFileURL(join(project, "main.ts")).href;
			open(
				socket,
				uri,
				"typescript",
				'const greeting = { hello: 1 };\nconst wrong: number = "text";\ngreeting.\n',
			);
			socket.send({
				jsonrpc: "2.0",
				id: 2,
				method: "textDocument/diagnostic",
				params: { textDocument: { uri } },
			});
			const report = (await socket.response(2, SLOW)).result as {
				items: Array<{ message: string }>;
			};
			expect(report.items.map((item) => item.message).join("\n")).toContain(
				"Type 'string' is not assignable to type 'number'.",
			);

			socket.send({
				jsonrpc: "2.0",
				id: 3,
				method: "textDocument/completion",
				params: { textDocument: { uri }, position: { line: 2, character: 9 } },
			});
			expect(labels((await socket.response(3, SLOW)).result)).toContain("hello");

			socket.send({
				jsonrpc: "2.0",
				id: 4,
				method: "textDocument/hover",
				params: { textDocument: { uri }, position: { line: 0, character: 8 } },
			});
			const hover = (await socket.response(4, SLOW)).result as {
				contents: { value: string };
			};
			expect(hover.contents.value).toContain("greeting");

			expect(
				socket.frames.some((frame) => frame.method === "workspace/configuration"),
			).toBe(false);
			socket.ws.close();
		},
		SLOW * 2,
	);
});
