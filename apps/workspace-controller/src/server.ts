import {
	CONTROLLER_BUDGET_HEADER,
	CONTROLLER_SHORT_BUDGET_MS,
	type ControllerErrorCode,
	CreateInstanceRequest,
	GROW_BUDGET_MS,
	GrowVolumesRequest,
	INSTANCE_CREATE_BUDGET_MS,
	InstanceName,
	KeptHomeVolumeName,
	MAINTENANCE_BUDGET_MS,
	PreChangeSnapshotName,
	RebuildInstanceRequest,
	ResetDockerRequest,
	SeedBuildRequest,
	SetCpuAllowanceRequest,
	SetInstanceLimitsRequest,
	SetLogLevelRequest,
	StartInstanceRequest,
	StopInstanceRequest,
	startBudgetMs,
	stopBudgetMs,
	WorkspaceVolumeName,
} from "@portikus/contracts";
import {
	applyLevel,
	type Logger,
	type LogLevel,
	quietLogController,
	registerRequestLogging,
	silentLogger,
} from "@portikus/observability";
import Fastify, {
	type FastifyBaseLogger,
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
} from "fastify";
import { tokenAuth } from "./auth.js";
import { SeedBuildBusyError, type SeedBuildHost, SeedBuilds } from "./docker-seed.js";
import { type EgressRouteOptions, registerEgressRoutes } from "./egress/routes.js";
import { VolumeInUseError } from "./host.js";
import { IncusError } from "./incus.js";
import { InstanceNotStoppedError, type WorkspaceProvider } from "./provider.js";

const ERROR_STATUS: Record<ControllerErrorCode, number> = {
	BAD_REQUEST: 400,
	INVALID_NAME: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	ALREADY_EXISTS: 409,
	INCUS_UNAVAILABLE: 503,
	TIMEOUT: 504,
	OPERATION_FAILED: 500,
	IMAGE_NOT_FOUND: 404,
	STORAGE_FULL: 507,
	POOL_FULL: 507,
};

interface Schema<T> {
	safeParse(
		value: unknown,
	):
		| { success: true; data: T }
		| { success: false; error: { issues: Array<{ message: string }> } };
}

/** Parse a request value, or answer 400 BAD_REQUEST and return null. */
function parseOr400<T>(
	schema: Schema<T>,
	value: unknown,
	reply: FastifyReply,
	message?: string,
): T | null {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	reply.code(400).send({
		code: "BAD_REQUEST",
		message: message ?? parsed.error.issues.map((i) => i.message).join("; "),
	});
	return null;
}

/** Check an instance name from the path, or answer 400 INVALID_NAME. */
function validName(name: string, reply: FastifyReply): boolean {
	if (InstanceName.safeParse(name).success) return true;
	reply.code(400).send({ code: "INVALID_NAME", message: "invalid instance name" });
	return false;
}

/**
 * One signal for a request: aborted when the caller's budget header runs out
 * (or `fallbackMs` without one; a larger header is clamped to it, since a
 * timer past 2^31-1 ms fires at once), or when the caller hangs up before the reply
 * is sent (ADR 0034). Incus requests keep their own default timeout too.
 */
export function callerSignal(
	request: FastifyRequest,
	reply: FastifyReply,
	fallbackMs: number,
): AbortSignal {
	const header = Number(request.headers[CONTROLLER_BUDGET_HEADER]);
	const budgetMs =
		Number.isSafeInteger(header) && header > 0
			? Math.min(header, fallbackMs)
			: fallbackMs;
	const controller = new AbortController();
	// Fastify logs only on reply, so an operator would otherwise not see why work stopped.
	const abort = (why: string) => {
		if (controller.signal.aborted) return;
		const instance = (request.params as { name?: string } | undefined)?.name;
		request.log.info({ route: request.routeOptions?.url, instance }, why);
		controller.abort(new IncusError("TIMEOUT", why));
	};
	const timer = setTimeout(() => abort("caller budget ran out"), budgetMs);
	timer.unref();
	reply.raw.once("close", () => {
		clearTimeout(timer);
		if (!reply.raw.writableEnded) abort("caller hung up");
	});
	return controller.signal;
}

interface Flight {
	controller: AbortController;
	promise: Promise<unknown>;
	/** Callers still waiting; the work is aborted when this falls to zero. */
	waiters: number;
	/** Settles, never rejects, once the work has finished and the entry is gone. */
	settled: Promise<void>;
}

interface ServerOptions {
	provider: WorkspaceProvider;
	token: string;
	/** The process logger. Tests default to one that writes nothing. */
	logger?: Logger;
	/** Where the egress routes meet the root helper; tests point it elsewhere. */
	egress?: EgressRouteOptions;
	/** Where a Docker seed is built. */
	seedHost: SeedBuildHost;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
	const { provider, token } = opts;
	// Keep the root logger: Fastify wraps it in a child, so setting a level on
	// the instance would leave this process's own debug lines silent (ADR 0012).
	const rootLogger = opts.logger ?? silentLogger();
	const app = Fastify({
		// Cast so the instance keeps Fastify's default logger type and
		// callers can still hold it as a plain FastifyInstance.
		loggerInstance: rootLogger as FastifyBaseLogger,
		logController: quietLogController(),
	});
	// The worker polls /docker-seed every minute; "no seed yet" is a normal 404.
	registerRequestLogging(app, { debugPaths: ["/health", "/docker-seed"] });

	// The level to return to when the worker clears the override (ADR 0012).
	const startLevel = rootLogger.level as LogLevel;

	app.addHook("preHandler", tokenAuth(token));

	const inflight = new Map<string, Flight>();

	/**
	 * Run `fn` once per key; callers that arrive meanwhile share its result.
	 * The shared work gets its own signal, aborted only when every caller
	 * with a signal has left and none without one waits (ADR 0034). A caller
	 * whose signal aborts is rejected at once. A caller that arrives while an
	 * aborted run winds down waits for it, then starts a fresh run.
	 */
	function singleFlight<T>(
		key: string,
		caller: AbortSignal | undefined,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const existing = inflight.get(key);
		if (existing?.controller.signal.aborted) {
			return existing.settled.then(() => singleFlight(key, caller, fn));
		}
		let flight = existing;
		if (!flight) {
			const controller = new AbortController();
			const promise = fn(controller.signal);
			const created: Flight = {
				controller,
				promise,
				waiters: 0,
				// Drop the entry as the work settles, so a request arriving in the
				// settlement window performs the operation instead of joining an
				// already-finished one.
				settled: promise.then(
					() => forget(key, created),
					() => forget(key, created),
				),
			};
			inflight.set(key, created);
			flight = created;
		}
		return join(flight, caller) as Promise<T>;
	}

	function forget(key: string, flight: Flight): void {
		if (inflight.get(key) === flight) inflight.delete(key);
	}

	function join(flight: Flight, caller: AbortSignal | undefined): Promise<unknown> {
		flight.waiters++;
		if (!caller) return flight.promise;
		const leave = (): void => {
			flight.waiters--;
			if (flight.waiters === 0) flight.controller.abort(caller.reason);
		};
		if (caller.aborted) {
			leave();
			return Promise.reject(caller.reason);
		}
		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				leave();
				reject(caller.reason);
			};
			caller.addEventListener("abort", onAbort, { once: true });
			flight.promise.then(
				(value) => {
					caller.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(err) => {
					caller.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	app.get("/health", async () => {
		const incusOk = await provider.healthy();
		return {
			status: "ok",
			service: "workspace-controller",
			uptimeSeconds: process.uptime(),
			incus: incusOk ? "reachable" : "unreachable",
		};
	});

	// The worker turns debug logging on and off while the controller runs
	// (ADR 0012); the level lives only in this process.
	app.put("/log-level", async (request, reply) => {
		const body = parseOr400(
			SetLogLevelRequest,
			request.body,
			reply,
			"unknown log level",
		);
		if (body === null) return reply;
		// Null clears the override, so the controller goes back to the level it
		// started with, from its own environment (ADR 0012).
		applyLevel(rootLogger, startLevel, body.level);
		return reply.code(204).send();
	});

	app.post("/instances", async (request, reply) => {
		const body = parseOr400(CreateInstanceRequest, request.body, reply);
		if (body === null) return reply;
		const started = Date.now();
		const signal = callerSignal(request, reply, INSTANCE_CREATE_BUDGET_MS);
		try {
			const result = await singleFlight(`create:${body.name}`, signal, (shared) =>
				provider.create(
					body.name,
					{
						homeGiB: body.homeGiB,
						dockerGiB: body.dockerGiB,
						recoveryGiB: body.recoveryGiB,
					},
					shared,
				),
			);
			request.log.info(
				{
					instance: body.name,
					created: result.created,
					durationMs: Date.now() - started,
				},
				"instance created",
			);
			const status = result.created ? 201 : 200;
			return reply.code(status).send(result);
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	app.post("/instances/:name/start", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(StartInstanceRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		const started = Date.now();
		const signal = callerSignal(request, reply, startBudgetMs(body.timeoutSeconds));
		try {
			const result = await singleFlight(`start:${params.name}`, signal, (shared) =>
				provider.start(
					params.name,
					{
						timeoutSeconds: body.timeoutSeconds,
						agentToken: body.agentToken,
						hostname: body.hostname,
						previewHostSuffix: body.previewHostSuffix,
						timezone: body.timezone,
						dockerGiB: body.dockerGiB,
						recoveryGiB: body.recoveryGiB,
						cpuAllowance: body.cpuAllowance,
						docker: body.docker,
					},
					shared,
				),
			);
			request.log.info(
				{ instance: params.name, durationMs: Date.now() - started },
				"instance started",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	app.post("/instances/:name/stop", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(StopInstanceRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		const started = Date.now();
		const signal = callerSignal(request, reply, stopBudgetMs(body.timeoutSeconds));
		try {
			const result = await singleFlight(`stop:${params.name}`, signal, (shared) =>
				provider.stop(params.name, { timeoutSeconds: body.timeoutSeconds }, shared),
			);
			request.log.info(
				{
					instance: params.name,
					forced: result.forced,
					durationMs: Date.now() - started,
				},
				"instance stopped",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	// Maintenance operations (ADR 0021). The worker stops the instance first;
	// the provider refuses a running one and this answers 409.
	app.post("/instances/:name/reset-docker", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(ResetDockerRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		const started = Date.now();
		const signal = callerSignal(request, reply, MAINTENANCE_BUDGET_MS);
		try {
			await singleFlight(`reset-docker:${params.name}`, signal, (shared) =>
				provider.resetDocker(params.name, { dockerGiB: body.dockerGiB }, shared),
			);
			request.log.info(
				{ instance: params.name, durationMs: Date.now() - started },
				"docker reset",
			);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	app.post("/instances/:name/rebuild", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(RebuildInstanceRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		const started = Date.now();
		const signal = callerSignal(request, reply, MAINTENANCE_BUDGET_MS);
		try {
			const result = await singleFlight(`rebuild:${params.name}`, signal, (shared) =>
				provider.rebuild(params.name, body, shared),
			);
			request.log.info(
				{
					instance: params.name,
					resetDocker: body.resetDocker,
					durationMs: Date.now() - started,
				},
				"instance rebuilt",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	app.get("/instances", async (_request, reply) => {
		try {
			const result = await provider.list();
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The worker samples this once a minute for the admin Health tab (SPEC.md §25.6).
	app.get("/host", async (_request, reply) => {
		try {
			return reply.code(200).send(await provider.hostSnapshot());
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The worker samples this once a minute for the resource guard (ADR 0032).
	app.get("/instances/usage", async (_request, reply) => {
		try {
			return reply.code(200).send({ instances: await provider.usage() });
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The worker asks for this when an administrator presses Refresh (ADR 0037).
	app.get("/instances/:name/processes", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const signal = callerSignal(request, reply, CONTROLLER_SHORT_BUDGET_MS);
		try {
			const processes = await singleFlight(
				`processes:${params.name}`,
				signal,
				(shared) => provider.processes(params.name, shared),
			);
			return reply.code(200).send({ processes });
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	app.put("/instances/:name/cpu-allowance", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(SetCpuAllowanceRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		try {
			await provider.setCpuAllowance(params.name, body.allowance);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Per-workspace limits on the instance, never the profile (SPEC.md §19.3).
	app.put("/instances/:name/limits", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(SetInstanceLimitsRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		try {
			await provider.setLimits(params.name, body);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The worker's daily package survey reads the apt hook's list (SPEC.md §20.1).
	app.get("/instances/:name/added-packages", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		try {
			return reply.code(200).send(await provider.addedPackages(params.name));
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Swap an imported home in, keeping the old one (ADR 0021's pattern).
	app.post("/instances/:name/replace-home", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const started = Date.now();
		try {
			const result = await singleFlight(`replace-home:${params.name}`, undefined, () =>
				provider.replaceHome(params.name),
			);
			request.log.info(
				{ instance: params.name, kept: result.kept, durationMs: Date.now() - started },
				"home replaced",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.get("/volumes/kept", async (_request, reply) => {
		try {
			return reply.code(200).send(await provider.keptVolumes());
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Only pre-change snapshots of a workspace's own volumes can be deleted.
	app.delete("/volumes/:volume/snapshots/:snapshot", async (request, reply) => {
		const params = request.params as { volume: string; snapshot: string };
		if (
			!WorkspaceVolumeName.safeParse(params.volume).success ||
			!PreChangeSnapshotName.safeParse(params.snapshot).success
		) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: "only pre-change snapshots can be deleted",
			});
		}
		try {
			await provider.deleteSnapshot(params.volume, params.snapshot);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Only a home kept by Replace home can be deleted by name.
	app.delete("/volumes/:volume", async (request, reply) => {
		const params = request.params as { volume: string };
		if (!KeptHomeVolumeName.safeParse(params.volume).success) {
			return reply
				.code(400)
				.send({ code: "BAD_REQUEST", message: "only kept homes can be deleted" });
		}
		try {
			await provider.deleteKeptHome(params.volume);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post("/instances/:name/volumes", async (request, reply) => {
		const params = request.params as { name: string };
		if (!validName(params.name, reply)) return reply;
		const body = parseOr400(GrowVolumesRequest, request.body ?? {}, reply);
		if (body === null) return reply;
		const signal = callerSignal(request, reply, GROW_BUDGET_MS);
		try {
			const result = await provider.growVolumes(params.name, body, signal);
			request.log.info({ instance: params.name, ...result }, "volumes grown");
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err, signal);
		}
	});

	// The Docker seed: one build at a time, polled by the worker.
	const seedBuilds = new SeedBuilds(opts.seedHost, rootLogger);

	app.post("/docker-seed/builds", async (request, reply) => {
		const body = parseOr400(SeedBuildRequest, request.body, reply);
		if (body === null) return reply;
		try {
			return reply.code(202).send(seedBuilds.start(body));
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.get("/docker-seed/builds/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const status = seedBuilds.get(id);
		if (!status) {
			return reply.code(404).send({ code: "NOT_FOUND", message: "no such seed build" });
		}
		return reply.code(200).send(status);
	});

	app.get("/docker-seed", async (_request, reply) => {
		try {
			const seed = await provider.seedInfo();
			if (!seed) {
				return reply.code(404).send({ code: "NOT_FOUND", message: "no Docker seed" });
			}
			return reply.code(200).send(seed);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	registerEgressRoutes(app, opts.egress);

	return app;
}

function sendError(
	reply: { code: (n: number) => { send: (b: unknown) => unknown } },
	err: unknown,
	signal?: AbortSignal,
): unknown {
	// Once the caller's deadline has passed, its reason (a TIMEOUT) is the answer, not the side effect.
	if (signal?.aborted) err = signal.reason;
	if (
		err instanceof InstanceNotStoppedError ||
		err instanceof VolumeInUseError ||
		err instanceof SeedBuildBusyError
	) {
		return reply.code(409).send({ code: err.code, message: err.message });
	}
	if (err instanceof IncusError) {
		const status = ERROR_STATUS[err.code] ?? 500;
		return reply.code(status).send({ code: err.code, message: err.message });
	}
	// The controller is reachable on loopback only and answers the worker, so
	// the real message is safe here and the request logging hook records it.
	return reply.code(500).send({
		code: "OPERATION_FAILED",
		message: err instanceof Error ? err.message : "unexpected error",
	});
}
