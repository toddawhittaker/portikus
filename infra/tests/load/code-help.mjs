// Code help for one simulated student (SPEC.md 13.6, 25.1): a Python and a
// TypeScript file open over the API's language-server sockets, each edited
// and asked for a completion every tick, and ruff open beside the Python file
// as the editor keeps it for Format.
import { openSocket } from "./http.mjs";

const TIMEOUT_MS = 15000;

// Each file alternates between two last lines, one of them an error, so
// every edit changes the diagnostics. The completion is asked right after
// the dot, which both lines share.
const FILES = {
	python: {
		name: "main.py",
		language: "python",
		body: [
			"import json",
			"import os",
			"",
			"",
			"def load(path: str) -> dict:",
			"    with open(path) as handle:",
			"        return json.load(handle)",
			"",
			"",
			'config = load(os.path.join("data", "config.json"))',
		].join("\n"),
		lines: ["result = os.path.", 'result = os.path.join("a", "b")'],
		dot: "result = os.path.".length,
		pull: false,
	},
	typescript: {
		name: "main.ts",
		language: "typescript",
		body: [
			"interface Item {",
			"\tname: string;",
			"\tcount: number;",
			"}",
			"",
			'const items: Item[] = [{ name: "a", count: 1 }];',
			"",
			"export function total(list: Item[]): number {",
			"\treturn list.reduce((sum, item) => sum + item.count, 0);",
			"}",
		].join("\n"),
		lines: [
			"export const result = items.",
			"export const result = items.map((item) => item.name);",
		],
		dot: "export const result = items.".length,
		// TypeScript 7's server offers pull diagnostics only.
		pull: true,
	},
};

const CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: false, willSave: false },
		completion: { completionItem: { snippetSupport: false } },
		publishDiagnostics: { versionSupport: true },
		diagnostic: { dynamicRegistration: false },
	},
	workspace: { configuration: true, workspaceFolders: true },
};

/** One JSON-RPC connection to a language server, one message per frame. */
class LanguageServerSocket {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Set();
		this.closed = null;
		socket.addEventListener("message", (event) => this.onMessage(event.data));
		socket.addEventListener("close", (event) => {
			this.closed = `closed ${event.code} ${event.reason}`;
			for (const { reject } of this.pending.values()) reject(new Error(this.closed));
			this.pending.clear();
		});
	}

	onMessage(data) {
		const message = JSON.parse(
			typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
		);
		if (message.method && message.id !== undefined) {
			// The servers ask for settings and registrations; defaults are fine.
			const result =
				message.method === "workspace/configuration"
					? (message.params?.items ?? []).map(() => null)
					: null;
			this.send({ jsonrpc: "2.0", id: message.id, result });
		} else if (message.method) {
			for (const listener of this.listeners) listener(message);
		} else {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.error)
				waiter.reject(new Error(`${message.error.code} ${message.error.message}`));
			else waiter.resolve(message.result);
		}
	}

	send(message) {
		if (this.closed) throw new Error(this.closed);
		this.socket.send(JSON.stringify(message));
	}

	notify(method, params) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	request(method, params, timeoutMs = TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.get(id)?.reject(error);
				this.pending.delete(id);
			}
		});
	}

	/** Resolves at the first notification `match` accepts. */
	waitFor(match, what, timeoutMs = TIMEOUT_MS) {
		return new Promise((resolve, reject) => {
			const listener = (message) => {
				if (!match(message)) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(performance.now());
			};
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`${what}: none within ${timeoutMs} ms`));
			}, timeoutMs);
			this.listeners.add(listener);
		});
	}

	close() {
		this.socket.close();
	}
}

export class CodeHelp {
	/** `student` gives the API, the cookie, the workspace and the project. */
	constructor(student) {
		this.student = student;
		this.servers = {};
		this.versions = {};
		this.tick = 0;
	}

	uri(file) {
		return `file:///home/student/projects/${this.student.projectSlug}/${file.name}`;
	}

	text(file, line) {
		return `${file.body}\n${line}\n`;
	}

	/** Writes both files, opens the three sockets, and opens the documents. */
	async open() {
		const s = this.student;
		for (const file of Object.values(FILES)) {
			await s.call(
				"PUT",
				`/workspaces/${s.id}/projects/${s.projectId}/file?path=${file.name}`,
				"/file",
				{
					body: this.text(file, file.lines[1]),
					type: "text/plain",
					headers: { "if-none-match": "*" },
					expect: [200, 201],
				},
			);
		}
		await Promise.all(
			["python", "typescript", "ruff"].map((id) =>
				s.measure(`code-help ready ${id}`, () => this.connect(id)),
			),
		);
	}

	async connect(id) {
		const s = this.student;
		const started = performance.now();
		const socket = await openSocket(
			`${s.api.replace(/^https/, "wss")}/workspaces/${s.id}/projects/${s.projectId}/language-servers/${id}`,
			{ origin: s.api, cookie: s.cookie },
		);
		s.sockets.push(socket);
		const server = new LanguageServerSocket(socket);
		await server.request(
			"initialize",
			{ processId: null, rootUri: null, capabilities: CAPABILITIES },
			60000,
		);
		server.notify("initialized", {});
		const file = id === "typescript" ? FILES.typescript : FILES.python;
		this.versions[file.name] = 1;
		server.notify("textDocument/didOpen", {
			textDocument: {
				uri: this.uri(file),
				languageId: file.language,
				version: 1,
				text: this.text(file, file.lines[1]),
			},
		});
		this.servers[id] = server;
		return performance.now() - started;
	}

	/** One edit and one completion in each file. */
	async act() {
		this.tick += 1;
		await Promise.all([this.edit("python"), this.edit("typescript")]);
	}

	async edit(id) {
		const s = this.student;
		const file = FILES[id];
		const server = this.servers[id];
		if (!server) return;
		const uri = this.uri(file);
		const version = ++this.versions[file.name];
		const line = file.lines[this.tick % 2];
		const change = {
			textDocument: { uri, version },
			contentChanges: [{ text: this.text(file, line) }],
		};
		const diagnosed = file.pull
			? null
			: server.waitFor(
					(m) =>
						m.method === "textDocument/publishDiagnostics" &&
						m.params?.uri === uri &&
						(m.params.version ?? version) >= version,
					"diagnostics",
				);
		diagnosed?.catch(() => {});
		const sent = performance.now();
		try {
			server.notify("textDocument/didChange", change);
			if (id === "python") this.servers.ruff?.notify("textDocument/didChange", change);
		} catch (error) {
			s.metrics.fail(`completion ${id}`, `${s.key} ${error.message}`);
			return;
		}
		const lineNumber = file.body.split("\n").length;
		await Promise.all([
			s.measure(`completion ${id}`, async () => {
				const began = performance.now();
				const result = await server.request("textDocument/completion", {
					textDocument: { uri },
					position: { line: lineNumber, character: file.dot },
					context: { triggerKind: 2, triggerCharacter: "." },
				});
				const items = Array.isArray(result) ? result : result?.items;
				if (!items?.length) throw new Error("no completion items");
				return performance.now() - began;
			}),
			s.measure(`diagnostics ${id}`, async () => {
				if (file.pull) {
					await server.request("textDocument/diagnostic", { textDocument: { uri } });
					return performance.now() - sent;
				}
				return (await diagnosed) - sent;
			}),
		]);
	}

	close() {
		for (const server of Object.values(this.servers)) server.close();
	}
}
