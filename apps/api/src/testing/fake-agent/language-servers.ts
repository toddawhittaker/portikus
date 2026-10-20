import type { WebSocket } from "@fastify/websocket";
import { LanguageServerId } from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** The first characters of a file, which every scripted answer points at. */
const FIRST_CHARACTER = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 1 },
};

/** What a test can read and steer on the fake's language-server sockets. */
export interface FakeLanguageServers {
	/** Every text frame the fake received, in order, unparsed. */
	received: string[];
	/** How each socket was closed by the caller, in order. */
	closes: Array<{ code: number; reason: string }>;
	/** While true the route answers 404, like an agent from before code help. */
	routeMissing: boolean;
	/** Sockets open now. */
	open: () => number;
	/** Send one raw text frame to every open socket. */
	push: (text: string) => number;
	/** Close every open socket from the agent's side. */
	closeAll: (code: number, reason?: string) => number;
}

/** Which capabilities each server id advertises, as the real programs do. */
function capabilities(server: LanguageServerId): Record<string, unknown> {
	const sync = { textDocumentSync: 2 };
	if (server === "ruff") return { ...sync, documentFormattingProvider: true };
	const features = {
		...sync,
		completionProvider: { triggerCharacters: ["."] },
		hoverProvider: true,
		definitionProvider: true,
		renameProvider: true,
	};
	// pyright pushes diagnostics; the TypeScript server is asked for them.
	if (server === "python") return features;
	return {
		...features,
		documentFormattingProvider: true,
		diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
	};
}

interface Message {
	id?: number | string;
	method?: string;
	params?: {
		textDocument?: { uri?: string };
		position?: { line: number; character: number };
		newName?: string;
	};
}

/** The scripted answer to one request; every answer is fixed. */
function answer(server: LanguageServerId, message: Message): unknown {
	const uri = message.params?.textDocument?.uri ?? "";
	switch (message.method) {
		case "initialize":
			return {
				capabilities: capabilities(server),
				serverInfo: { name: `fake-${server}`, version: "0.0.0" },
			};
		case "textDocument/completion":
			return {
				isIncomplete: false,
				items: [
					{ label: "portikus_example", kind: 3, detail: "scripted" },
					{ label: "portikus_value", kind: 6, detail: "scripted" },
				],
			};
		case "textDocument/hover":
			return {
				contents: { kind: "markdown", value: "**scripted hover**" },
				range: FIRST_CHARACTER,
			};
		case "textDocument/definition":
			return [{ uri, range: FIRST_CHARACTER }];
		case "textDocument/rename":
			return {
				changes: {
					[uri]: [{ range: FIRST_CHARACTER, newText: message.params?.newName ?? "" }],
				},
			};
		case "textDocument/formatting":
			return [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
					newText: "# formatted\n",
				},
			];
		case "textDocument/diagnostic":
			return {
				kind: "full",
				items: [
					{
						range: FIRST_CHARACTER,
						severity: 1,
						source: "fake",
						message: "scripted error",
					},
				],
			};
		default:
			// shutdown, and any request the script has no answer for.
			return null;
	}
}

/** The diagnostics a pushing server sends after a document opens or changes. */
function pushedDiagnostics(uri: string) {
	return {
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			diagnostics: [
				{
					range: FIRST_CHARACTER,
					severity: 2,
					source: "fake",
					message: "scripted warning",
				},
			],
		},
	};
}

/**
 * The agent's language-server socket with a scripted LSP responder behind it
 * (SPEC.md §13.6). It answers `initialize`, completion, hover, definition,
 * rename and formatting with fixed results, answers pull diagnostics, and
 * the `python` server pushes diagnostics when a document opens or changes.
 */
export function registerLanguageServerRoutes(
	app: FastifyInstance,
): FakeLanguageServers {
	const sockets = new Set<WebSocket>();
	const control: FakeLanguageServers = {
		received: [],
		closes: [],
		routeMissing: false,
		open: () => sockets.size,
		push(text) {
			for (const socket of sockets) socket.send(text);
			return sockets.size;
		},
		closeAll(code, reason = "") {
			const count = sockets.size;
			for (const socket of sockets) socket.close(code, reason);
			return count;
		},
	};

	app.get(
		"/projects/:slug/language-servers/:server",
		{
			websocket: true,
			preHandler: async (_request, reply) => {
				if (!control.routeMissing) return;
				return reply
					.status(404)
					.send({ error: { code: "NOT_FOUND", message: "Route not found" } });
			},
		},
		(socket: WebSocket, request: FastifyRequest) => {
			const server = LanguageServerId.safeParse(
				(request.params as { server: string }).server,
			);
			if (!server.success) {
				socket.close(4415, "unavailable");
				return;
			}
			sockets.add(socket);
			socket.on("close", (code: number, reason: Buffer) => {
				sockets.delete(socket);
				control.closes.push({ code, reason: reason.toString() });
			});
			socket.on("message", (data: Buffer) => {
				const text = data.toString();
				control.received.push(text);
				let message: Message;
				try {
					message = JSON.parse(text) as Message;
				} catch {
					return;
				}
				if (message.id !== undefined) {
					socket.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: answer(server.data, message),
						}),
					);
					return;
				}
				const opened =
					message.method === "textDocument/didOpen" ||
					message.method === "textDocument/didChange";
				if (opened && server.data === "python") {
					const uri = message.params?.textDocument?.uri ?? "";
					socket.send(JSON.stringify(pushedDiagnostics(uri)));
				}
				if (message.method === "exit") socket.close(1000, "");
			});
		},
	);

	// Lets a browser test play a crash or a replacement without a real server.
	app.post("/__test/language-servers/close", async (request, reply) => {
		const body = request.body as { code: number };
		return reply.status(200).send({ closed: control.closeAll(body.code) });
	});

	return control;
}
