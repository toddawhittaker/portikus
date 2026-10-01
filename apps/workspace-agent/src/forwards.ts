/**
 * Loopback forwards (BROWSER-HANDLING.md §11.1, §11.2). A forward is a
 * listener on the container's workspace-reachable interface that copies bytes
 * to and from the loopback address that port is listening on in this
 * container, on the same port, and nothing else. It is not a general TCP proxy: it has no target address or port of
 * its own, and only the control plane's routes below can create one.
 */
import { connect, createServer, type Server, type Socket } from "node:net";
import type { LoopbackForward } from "@portikus/contracts";
import type { FastifyBaseLogger } from "fastify";
import { AgentFailure } from "./errors.js";
import type { ListeningMonitor } from "./listening.js";

interface Entry {
	server: Server;
	sockets: Set<Socket>;
}

export interface ForwardsOptions {
	/** The address the gateway reaches this container on. */
	interfaceAddress: string | null;
	monitor: ListeningMonitor;
	logger?: FastifyBaseLogger;
}

export class Forwards {
	private readonly entries = new Map<number, Entry>();
	private readonly interfaceAddress: string | null;
	private readonly monitor: ListeningMonitor;
	private readonly logger: FastifyBaseLogger | undefined;

	constructor(options: ForwardsOptions) {
		this.interfaceAddress = options.interfaceAddress;
		this.monitor = options.monitor;
		this.logger = options.logger;
	}

	/** The ports that currently have a forward, for discovery to report. */
	ports(): ReadonlySet<number> {
		return new Set(this.entries.keys());
	}

	list(): LoopbackForward[] {
		return [...this.entries.keys()]
			.sort((left, right) => left - right)
			.map((port) => ({
				port,
				address: this.interfaceAddress ?? "",
				state: "open" as const,
			}));
	}

	/** Open a forward, or return the one already open for this port. */
	async open(port: number): Promise<LoopbackForward> {
		const address = this.interfaceAddress;
		if (address === null) {
			throw new AgentFailure(
				"FORWARD_UNAVAILABLE",
				"this workspace has no reachable network interface",
			);
		}
		const existing = this.entries.get(port);
		if (existing) return { port, address, state: "open" };

		await this.monitor.refresh();
		if (!this.monitor.isLoopbackOnly(port)) {
			throw new AgentFailure(
				"FORWARD_NOT_LOOPBACK",
				"no service is listening on loopback only at that port",
			);
		}

		const sockets = new Set<Socket>();
		const server = createServer((incoming) => {
			sockets.add(incoming);
			// Asked again per connection: a restarted server can move between
			// the IPv4 and IPv6 loopback address on the same port.
			const host = this.monitor.loopbackTarget(port) ?? "127.0.0.1";
			const target = connect({ host, port });
			sockets.add(target);
			const drop = () => {
				sockets.delete(incoming);
				sockets.delete(target);
				incoming.destroy();
				target.destroy();
			};
			incoming.on("error", drop);
			target.on("error", drop);
			incoming.on("close", drop);
			target.on("close", drop);
			incoming.pipe(target);
			target.pipe(incoming);
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) => {
				reject(
					new AgentFailure(
						error.code === "EADDRINUSE" ? "FORWARD_PORT_IN_USE" : "FORWARD_FAILED",
						error.code === "EADDRINUSE"
							? "that port is already in use on the workspace interface"
							: "the forward could not be opened",
					),
				);
			});
			server.listen({ host: address, port }, () => resolve());
		});

		this.entries.set(port, { server, sockets });
		this.logger?.debug({ port }, "loopback forward opened");
		return { port, address, state: "open" };
	}

	/** Close a forward and every connection through it. Returns false if none. */
	close(port: number): boolean {
		const entry = this.entries.get(port);
		if (!entry) return false;
		this.entries.delete(port);
		entry.server.close();
		for (const socket of entry.sockets) socket.destroy();
		entry.sockets.clear();
		this.logger?.debug({ port }, "loopback forward closed");
		return true;
	}

	closeEverything(): void {
		for (const port of [...this.entries.keys()]) this.close(port);
	}

	/**
	 * Close any forward whose loopback listener has gone away: the service it
	 * pointed at is no longer running (BROWSER-HANDLING.md §11.1).
	 */
	reconcile(): void {
		for (const port of [...this.entries.keys()]) {
			if (!this.monitor.hasLoopbackListener(port)) this.close(port);
		}
	}
}
