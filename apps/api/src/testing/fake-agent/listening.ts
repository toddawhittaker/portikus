import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import type { AgentListeningService } from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import type { FakeAgentState } from "./state.js";

/** The workspace interface address a loopback forward listens on. */
const FORWARD_ADDRESS = "10.0.0.2";

/**
 * Listening services, port stops and probes, and loopback forwards, like the
 * agent's listening-route.ts (BROWSER-HANDLING.md §11.1).
 */
export function registerListeningRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		flags,
		listening,
		listeningSockets,
		forwards,
		probes,
		httpsApps,
		testApps,
		appHits,
		keyOf,
	} = s;
	function listeningFor(key: string): AgentListeningService[] {
		return listening.get(key) ?? [];
	}

	function sendListening(socket: WebSocket, services: AgentListeningService[]): void {
		if (socket.readyState !== socket.OPEN) return;
		socket.send(
			JSON.stringify({
				type: "workspace.listening-services.changed",
				services,
				observedAt: new Date().toISOString(),
			}),
		);
	}

	function pushListening(key: string): void {
		for (const socket of listeningSockets.get(key) ?? []) {
			sendListening(socket, listeningFor(key));
		}
	}

	/**
	 * Mirror the real agent: an open forward makes a loopback port reachable
	 * and adds the agent's own listener on the workspace interface. The port
	 * stays the student's, owned by their process.
	 */
	function markForwarded(key: string, port: number, open: boolean): void {
		listening.set(
			key,
			listeningFor(key).map((service) => {
				if (service.port !== port) return service;
				const addresses = service.addresses.filter(
					(address) => address !== FORWARD_ADDRESS,
				);
				return {
					...service,
					addresses: open ? [...addresses, FORWARD_ADDRESS] : addresses,
					previewReachability: open ? ("forwarded" as const) : ("unknown" as const),
					system: false,
				};
			}),
		);
		pushListening(key);
	}

	/** A real HTTP and WebSocket application, on a port of its own. */
	async function startTestApp(
		title: string,
		frameOptions?: string,
		delayMs = 0,
		https = false,
	): Promise<number> {
		let ownPort = 0;
		const handler: RequestListener = (_req, res) => {
			appHits.set(ownPort, (appHits.get(ownPort) ?? 0) + 1);
			const headers: Record<string, string> = {
				"content-type": "text/html; charset=utf-8",
			};
			// An application that refuses framing, so a test can drive the
			// "cannot be embedded" path (BROWSER-HANDLING.md §12).
			if (frameOptions) headers["x-frame-options"] = frameOptions;
			const answer = () => {
				res.writeHead(200, headers);
				res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
			};
			if (delayMs > 0) setTimeout(answer, delayMs).unref?.();
			else answer();
		};
		// An application serving HTTPS, as `vite --https` does.
		const server = https
			? createHttpsServer(selfSignedCertificate(), handler)
			: createServer(handler);
		const sockets = new WebSocketServer({ server });
		sockets.on("connection", (socket) => {
			socket.on("message", (data: Buffer) => socket.send(`echo:${data.toString()}`));
			socket.send("hello");
		});
		testApps.push(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		ownPort = (server.address() as AddressInfo).port;
		return ownPort;
	}

	app.get("/listening", async (request) => ({
		services: listeningFor(keyOf(request)),
	}));

	app.get(
		"/listening/events",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const key = keyOf(request);
			const peers = listeningSockets.get(key) ?? new Set<WebSocket>();
			peers.add(socket);
			listeningSockets.set(key, peers);
			socket.on("close", () => peers.delete(socket));
			// Like the real agent, the first frame is the whole list.
			sendListening(socket, listeningFor(key));
		},
	);

	/**
	 * Stop a listener, like the real agent: a system row is
	 * refused, an unknown port is a 404, and anything else simply disappears
	 * from the list, which is what discovery would report a second later.
	 */
	app.post("/listening/:port/stop", async (request, reply) => {
		const port = Number.parseInt((request.params as { port: string }).port, 10);
		const hold = flags.stopHold;
		flags.stopHold = null;
		if (hold) {
			hold.arrived();
			await hold.released;
		}
		const key = keyOf(request);
		const service = listeningFor(key).find((one) => one.port === port);
		if (!service) {
			return reply.status(404).send({
				error: { code: "LISTENER_NOT_FOUND", message: "nothing is listening" },
			});
		}
		if (service.system) {
			return reply.status(403).send({
				error: { code: "LISTENER_IS_SYSTEM", message: "system service" },
			});
		}
		listening.set(
			key,
			listeningFor(key).filter((one) => one.port !== port),
		);
		pushListening(key);
		return { port, stopped: true };
	});

	/**
	 * Settle a port's protocol, like the real agent: the first
	 * request "probes" (a test app started with https answers https; a seeded
	 * row keeps its hint) and later ones are answered from the result.
	 */
	app.post("/listening/:port/probe", async (request, reply) => {
		const port = Number.parseInt((request.params as { port: string }).port, 10);
		const key = keyOf(request);
		const service = listeningFor(key).find((one) => one.port === port);
		if (!service) {
			return reply.status(404).send({
				error: { code: "LISTENER_NOT_FOUND", message: "nothing is listening" },
			});
		}
		if (service.protocolKnown) return { service };
		probes.set(key, [...(probes.get(key) ?? []), port]);
		const probed: AgentListeningService = {
			...service,
			protocolHint: httpsApps.has(port) ? "https" : service.protocolHint,
			protocolKnown: true,
		};
		listening.set(
			key,
			listeningFor(key).map((one) => (one.port === port ? probed : one)),
		);
		pushListening(key);
		return { service: probed };
	});

	app.get("/forwards", async (request) => ({
		forwards: [...(forwards.get(keyOf(request)) ?? new Set<number>())].map((port) => ({
			port,
			address: FORWARD_ADDRESS,
			state: "open" as const,
		})),
	}));

	app.post("/forwards", async (request, reply) => {
		const body = request.body as { port?: number };
		const port = body?.port;
		if (typeof port !== "number") {
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid port" } });
		}
		if (flags.failForward) {
			return reply
				.status(409)
				.send({ error: { code: "INTERNAL", message: "cannot bind" } });
		}
		const key = keyOf(request);
		const open = forwards.get(key) ?? new Set<number>();
		open.add(port);
		forwards.set(key, open);
		markForwarded(key, port, true);
		return { port, address: FORWARD_ADDRESS, state: "open" };
	});

	app.delete("/forwards/:port", async (request, reply) => {
		const port = Number.parseInt((request.params as { port: string }).port, 10);
		const key = keyOf(request);
		const open = forwards.get(key) ?? new Set<number>();
		if (!open.delete(port)) {
			return reply
				.status(404)
				.send({ error: { code: "INTERNAL", message: "no such forward" } });
		}
		markForwarded(key, port, false);
		return reply.status(204).send();
	});

	/**
	 * Seed what the workspace is listening on. The body is the whole list, so
	 * a test can also clear it by sending an empty array.
	 */
	app.post("/__test/listening", async (request, reply) => {
		const body = request.body as {
			key?: string;
			services?: Partial<AgentListeningService>[];
		};
		const key = body.key ?? "";
		listening.set(
			key,
			(body.services ?? []).map((service) => ({
				port: service.port ?? 0,
				addresses: service.addresses ?? ["0.0.0.0"],
				protocolHint: service.protocolHint ?? "http",
				...(service.protocolKnown !== undefined
					? { protocolKnown: service.protocolKnown }
					: {}),
				previewReachability: service.previewReachability ?? "reachable",
				system: service.system ?? false,
				...(service.process ? { process: service.process } : {}),
				...(service.container ? { container: service.container } : {}),
				observedAt: new Date().toISOString(),
			})),
		);
		pushListening(key);
		return reply.status(204).send();
	});

	/**
	 * Start a tiny HTTP and WebSocket application on a free port and report it
	 * as listening, so an end-to-end test can drive a real preview.
	 */
	app.post("/__test/app", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			title?: string;
			frameOptions?: string;
			delayMs?: number;
			https?: boolean;
		};
		const key = body.key ?? "";
		const title = body.title ?? "Portikus test app";
		const port = await startTestApp(
			title,
			body.frameOptions,
			body.delayMs ?? 0,
			body.https === true,
		);
		if (body.https === true) httpsApps.add(port);
		const current = listeningFor(key).filter((one) => one.port !== port);
		listening.set(key, [
			...current,
			{
				port,
				addresses: ["0.0.0.0"],
				// The real agent knows only after a preview asks it to probe.
				protocolHint: "unknown",
				previewReachability: "reachable",
				system: false,
				process: { pid: 4242, command: "node" },
				observedAt: new Date().toISOString(),
			},
		]);
		pushListening(key);
		return reply.status(201).send({ port });
	});
}

let certificate: { key: Buffer; cert: Buffer } | null = null;

/** A throwaway self-signed certificate for the HTTPS test app, made once. */
function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
	if (certificate) return certificate;
	const dir = mkdtempSync(join(tmpdir(), "portikus-fake-tls-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		certificate = {
			key: readFileSync(join(dir, "key.pem")),
			cert: readFileSync(join(dir, "cert.pem")),
		};
		return certificate;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
