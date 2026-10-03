import websocket from "@fastify/websocket";
import { SetLogLevelRequest } from "@portikus/contracts";
import {
	applyLevel,
	type Logger,
	type LogLevel,
	quietLogController,
	registerRequestLogging,
	silentLogger,
} from "@portikus/observability";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { tokenAuth } from "./auth.js";
import { startUrlBroker } from "./broker.js";
import { checksRoute } from "./checks-route.js";
import { type DockerRunner, dockerInventoryRoute } from "./docker-inventory.js";
import { ERROR_STATUS } from "./errors.js";
import { eventsRoute } from "./events-route.js";
import { filesRoutes } from "./files-route.js";
import { Forwards } from "./forwards.js";
import { gitRoutes } from "./git-routes.js";
import {
	ListeningMonitor,
	type ListeningMonitorOptions,
	workspaceInterfaceAddress,
} from "./listening.js";
import { listeningRoutes } from "./listening-route.js";
import { type PackagesRouteOptions, packagesRoutes } from "./packages-route.js";
import { protectedTree, tmuxPidSource } from "./processes.js";
import { processesRoutes } from "./processes-route.js";
import { projectsRoutes } from "./projects-route.js";
import { recoveryRoutes } from "./recovery-routes.js";
import { searchRoutes } from "./search-routes.js";
import { TerminalRegistry } from "./terminals.js";
import { terminalsRoutes } from "./terminals-route.js";
import { serverPid, type TmuxServer } from "./tmux.js";
import { UsageSampler, type UsageSamplerOptions } from "./usage.js";
import { ProjectWatchers } from "./watch.js";

export interface ServerOptions {
	tokenPath: string;
	homeDir: string;
	/** The tmux socket name, `portikus` in a workspace (SPEC.md §9.7). */
	tmuxSocketName: string;
	/** The terminals unit runs tmux, so the agent never starts it. */
	tmuxExternalServer?: boolean;
	/** The process logger. Tests default to one that writes nothing. */
	logger?: Logger;
	/** Overrides the cap on concurrent event sockets. For tests. */
	maxEventSockets?: number;
	/** Overrides the project watchers, so a test can break one. For tests. */
	watchers?: ProjectWatchers;
	/** Overrides where ports are discovered and how. For tests. */
	listening?: ListeningMonitorOptions;
	/**
	 * Unix socket for `portikus-open`. Unset in tests that do not exercise
	 * the broker; production passes `/run/portikus/browser.sock`.
	 */
	brokerSocketPath?: string;
	/** Overrides where usage is read. For tests. */
	usage?: UsageSamplerOptions;
	/** Mount point of the recovery volume (ADR 0020). */
	recoveryRoot?: string;
	/** Overrides where the terminals unit's exit record is read. For tests. */
	terminalsExitPath?: string;
	/** Overrides where the reinstall note reads the image and dpkg. For tests. */
	packages?: Omit<PackagesRouteOptions, "homeDir">;
	/**
	 * Which agent code is running, sent on every attach so an open page can
	 * tell the agent was upgraded under it.
	 */
	build?: string;
	/** Overrides how `docker` runs for the inventory route. For tests. */
	dockerRunner?: DockerRunner;
}

/** The workspace agent's HTTP and WebSocket surface (SPEC.md §9.7). */
export function buildServer(options: ServerOptions): FastifyInstance {
	// Keep the root logger: Fastify wraps it in a child, so setting a level on
	// the instance would leave this process's own debug lines silent (ADR 0012).
	const rootLogger = options.logger ?? silentLogger();
	const app = Fastify({
		// Fastify's default body limit stands for every route. The file write
		// route reads the raw stream and caps it itself (SPEC.md §11.2).
		// Cast so the instance keeps Fastify's default logger type and
		// callers can still hold it as a plain FastifyInstance.
		loggerInstance: rootLogger as FastifyBaseLogger,
		logController: quietLogController(),
	});
	// Usage is polled once a second and its body names processes, so the
	// request line stays at debug and the body is never logged (STACK.md §15).
	registerRequestLogging(app, { debugPaths: ["/health", "/usage"] });

	// The level to return to when the API clears the override (ADR 0012).
	const startLevel = rootLogger.level as LogLevel;

	const tmuxServer: TmuxServer = {
		socketName: options.tmuxSocketName,
		external: options.tmuxExternalServer ?? false,
	};
	const registry = new TerminalRegistry(options.homeDir, app.log, tmuxServer);
	const watchers = options.watchers ?? new ProjectWatchers(app.log);

	let closeBroker: () => Promise<void> = async () => {};
	if (options.brokerSocketPath) {
		const pending = startUrlBroker({
			socketPath: options.brokerSocketPath,
			homeDir: options.homeDir,
			watchers,
			log: app.log,
		});
		closeBroker = async () => {
			const handle = await pending;
			await handle.close();
		};
	}
	app.addHook("preClose", async () => {
		await closeBroker();
	});

	// Registered before @fastify/websocket's own preClose so attachments get a
	// close code before that plugin drops the sockets.
	app.addHook("preClose", async () => {
		registry.closeEverything();
	});

	// Port discovery and loopback forwards know about each other: discovery
	// reports a forwarded port as "forwarded", and a forward closes once its
	// loopback listener is gone (BROWSER-HANDLING.md §11.1).
	// The platform's own processes are protected by PID (SPEC.md §18.3).
	const procRoot = options.usage?.procRoot ?? "/proc";
	const tmuxPid = tmuxPidSource(procRoot, () => serverPid(tmuxServer));
	const protectedPids = async (fresh = false): Promise<ReadonlySet<number>> =>
		protectedTree(
			procRoot,
			options.usage?.selfPid ?? process.pid,
			await tmuxPid(fresh),
			registry.attachPids(),
		);
	const monitor = new ListeningMonitor({
		// Never reuse a cached "no tmux server" answer when protecting it (SPEC.md §18.3).
		protectedPids: () => protectedPids(true),
		...options.listening,
		logger: app.log,
		forwardedPorts: () => forwards.ports(),
	});
	const forwards = new Forwards({
		interfaceAddress:
			options.listening?.interfaceAddress === undefined
				? workspaceInterfaceAddress()
				: options.listening.interfaceAddress,
		monitor,
		logger: app.log,
	});
	monitor.subscribe(() => {
		forwards.reconcile();
	});
	monitor.start();

	const recoveryRoot = options.recoveryRoot ?? "/var/lib/portikus/recovery";
	const usage = new UsageSampler({
		homePath: options.homeDir,
		protectedPids,
		recoveryPath: recoveryRoot,
		...options.usage,
	});

	app.addHook("preClose", async () => {
		monitor.stop();
		forwards.closeEverything();
	});

	// A terminal input frame is small; refuse anything far past that before it
	// is buffered (SPEC.md §9.7).
	app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

	// Every route, the upgrade included, needs the token (SPEC.md §23.5). It
	// runs on request, so a caller without it never gets a body parsed.
	app.addHook("onRequest", tokenAuth(options.tokenPath));

	// A refused upgrade is answered over a socket Fastify does not track, so
	// close it here or shutdown waits for it forever.
	app.addHook("onResponse", async (request, reply) => {
		const upgrade = request.headers.upgrade;
		if (
			typeof upgrade === "string" &&
			upgrade.toLowerCase() === "websocket" &&
			reply.statusCode >= 400
		) {
			request.raw.socket.destroy();
		}
	});

	// Routes live in a child plugin so that @fastify/websocket has loaded and
	// wrapped the upgrade handler before they are registered.
	app.register(async (instance) => {
		instance.get("/health", async () => ({ ok: true }));

		// One sample serves the Monitor tab and the selected Running row.
		// The handler logs nothing: the body carries process names.
		instance.get("/usage", async () => usage.read());

		// The control plane turns debug logging on and off while the agent
		// runs (ADR 0012); the level lives only in this process.
		instance.put("/log-level", async (request, reply) => {
			const parsed = SetLogLevelRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply
					.code(ERROR_STATUS.BAD_REQUEST)
					.send({ error: { code: "BAD_REQUEST", message: "unknown log level" } });
			}
			// Null clears the override, so this agent goes back to the level it
			// started with, from its own environment (ADR 0012).
			applyLevel(rootLogger, startLevel, parsed.data.level);
			return reply.code(204).send();
		});

		instance.register(terminalsRoutes, {
			homeDir: options.homeDir,
			tmuxServer,
			registry,
			terminalsExitPath: options.terminalsExitPath,
			build: options.build,
		});
		instance.register(projectsRoutes, { homeDir: options.homeDir });
		instance.register(searchRoutes, { homeDir: options.homeDir });
		instance.register(filesRoutes, { homeDir: options.homeDir });
		instance.register(gitRoutes, { homeDir: options.homeDir });
		instance.register(recoveryRoutes, { homeDir: options.homeDir, recoveryRoot });
		instance.register(checksRoute, { homeDir: options.homeDir });
		instance.register(packagesRoutes, {
			...options.packages,
			homeDir: options.homeDir,
		});
		instance.register(listeningRoutes, { monitor, forwards });
		instance.register(dockerInventoryRoute, { run: options.dockerRunner });
		instance.register(processesRoutes, {
			procRoot: options.usage?.procRoot,
			protectedPids: () => protectedPids(true),
		});
		instance.register(eventsRoute, {
			homeDir: options.homeDir,
			maxSockets: options.maxEventSockets,
			watchers,
		});
	});

	return app;
}
