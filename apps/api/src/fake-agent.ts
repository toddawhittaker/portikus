import type { AddressInfo } from "node:net";
import websocket, { type WebSocket } from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * A stand-in for the workspace agent, used by the API tests. It checks the
 * bearer token, keeps terminals in memory, and echoes attach input back.
 */
export interface FakeAgent {
	port: number;
	token: string;
	terminals: Map<string, { cwd: string }>;
	/** Frames the fake received on an attach socket, in order. */
	received: string[];
	/** Attach sockets currently open on the fake. */
	readonly openAttachments: number;
	/** Make the next create call fail with this agent error code. */
	failCreateWith: string | null;
	close: () => Promise<void>;
}

export async function startFakeAgent(
	token: string,
	options: { port?: number } = {},
): Promise<FakeAgent> {
	const terminals = new Map<string, { cwd: string }>();
	// Every attachment of one terminal, so echoed output reaches them all,
	// the way a real shared tmux session would.
	const attached = new Map<string, Set<WebSocket>>();
	const received: string[] = [];
	const app: FastifyInstance = Fastify({ logger: false });
	await app.register(websocket);

	const state = { failCreateWith: null as string | null, openAttachments: 0 };

	function authorized(request: FastifyRequest): boolean {
		return request.headers.authorization === `Bearer ${token}`;
	}

	app.addHook("onRequest", async (request, reply) => {
		if (!authorized(request)) {
			return reply
				.status(401)
				.send({ error: { code: "UNAUTHORIZED", message: "bad token" } });
		}
	});

	app.get("/health", async () => ({ ok: true }));

	app.get("/terminals", async () => ({
		terminals: [...terminals].map(([id, value]) => ({
			id,
			cwd: value.cwd,
			attachments: 0,
		})),
	}));

	app.post("/terminals", async (request, reply) => {
		if (state.failCreateWith) {
			const code = state.failCreateWith;
			state.failCreateWith = null;
			return reply
				.status(code === "INVALID_CWD" ? 400 : 500)
				.send({ error: { code, message: "create refused" } });
		}
		const body = request.body as { id: string; cwd: string };
		terminals.set(body.id, { cwd: body.cwd });
		return reply.status(201).send({ ok: true });
	});

	app.delete("/terminals/:id", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		if (!terminals.delete(id)) {
			return reply
				.status(404)
				.send({ error: { code: "TERMINAL_NOT_FOUND", message: "no such terminal" } });
		}
		return reply.status(204).send();
	});

	app.get(
		"/terminals/:id/attach",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const id = (request.params as { id: string }).id;
			if (!terminals.has(id)) {
				socket.close(4404, "no such terminal");
				return;
			}
			state.openAttachments += 1;
			const peers = attached.get(id) ?? new Set<WebSocket>();
			peers.add(socket);
			attached.set(id, peers);
			socket.on("close", () => {
				state.openAttachments -= 1;
				peers.delete(socket);
			});
			const query = request.query as { cols?: string; rows?: string };
			socket.send(JSON.stringify({ type: "size", cols: query.cols, rows: query.rows }));
			socket.on("message", (data: Buffer) => {
				const text = data.toString();
				received.push(text);
				const parsed = JSON.parse(text) as { type: string; cols?: number };
				if (parsed.type === "resize") {
					socket.send(JSON.stringify({ type: "size", cols: parsed.cols }));
					return;
				}
				for (const peer of peers) {
					if (peer.readyState === peer.OPEN) {
						peer.send(Buffer.from(`echo:${text}`), { binary: true });
					}
				}
			});
		},
	);

	await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;

	return {
		port: address.port,
		token,
		terminals,
		received,
		get openAttachments() {
			return state.openAttachments;
		},
		get failCreateWith() {
			return state.failCreateWith;
		},
		set failCreateWith(code: string | null) {
			state.failCreateWith = code;
		},
		close: () => app.close(),
	};
}
