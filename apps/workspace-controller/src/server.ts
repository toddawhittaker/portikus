import {
	type ControllerErrorCode,
	CreateInstanceRequest,
	GrowVolumesRequest,
	InstanceName,
	KeptHomeVolumeName,
	PreChangeSnapshotName,
	RebuildInstanceRequest,
	ResetDockerRequest,
	SeedBuildRequest,
	SetCpuAllowanceRequest,
	SetInstanceLimitsRequest,
	SetLogLevelRequest,
	StartInstanceRequest,
	StopInstanceRequest,
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
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { tokenAuth } from "./auth.js";
import { SeedBuildBusyError, SeedBuilds } from "./docker-seed.js";
import { type EgressRouteOptions, registerEgressRoutes } from "./egress/routes.js";
import { IncusError } from "./incus.js";
import {
	InstanceNotStoppedError,
	VolumeInUseError,
	type WorkspaceProvider,
} from "./provider.js";

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

interface ServerOptions {
	provider: WorkspaceProvider;
	token: string;
	/** The process logger. Tests default to one that writes nothing. */
	logger?: Logger;
	/** Where the egress routes meet the root helper; tests point it elsewhere. */
	egress?: EgressRouteOptions;
	/** The seed build runner; tests pass their own. */
	seedBuilds?: SeedBuilds;
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

	const inflight = new Map<string, Promise<unknown>>();

	function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const existing = inflight.get(key);
		if (existing) {
			return existing as Promise<T>;
		}
		// Drop the entry as the promise settles, so a request arriving in
		// the settlement window performs the operation instead of joining
		// an already-finished one.
		const promise = fn().then(
			(value) => {
				inflight.delete(key);
				return value;
			},
			(err) => {
				inflight.delete(key);
				throw err;
			},
		);
		inflight.set(key, promise);
		return promise;
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
		const parsed = SetLogLevelRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.code(ERROR_STATUS.BAD_REQUEST)
				.send({ code: "BAD_REQUEST", message: "unknown log level" });
		}
		// Null clears the override, so the controller goes back to the level it
		// started with, from its own environment (ADR 0012).
		applyLevel(rootLogger, startLevel, parsed.data.level);
		return reply.code(204).send();
	});

	app.post("/instances", async (request, reply) => {
		const parsed = CreateInstanceRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: parsed.error.issues.map((i) => i.message).join("; "),
			});
		}
		const started = Date.now();
		try {
			const result = await provider.create(parsed.data.name, {
				homeGiB: parsed.data.homeGiB,
				dockerGiB: parsed.data.dockerGiB,
				recoveryGiB: parsed.data.recoveryGiB,
			});
			request.log.info(
				{
					instance: parsed.data.name,
					created: result.created,
					durationMs: Date.now() - started,
				},
				"instance created",
			);
			const status = result.created ? 201 : 200;
			return reply.code(status).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post("/instances/:name/start", async (request, reply) => {
		const params = request.params as { name: string };
		const nameResult = InstanceName.safeParse(params.name);
		if (!nameResult.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: "invalid instance name",
			});
		}
		const bodyResult = StartInstanceRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		const started = Date.now();
		try {
			const result = await singleFlight(`start:${params.name}`, () =>
				provider.start(params.name, {
					timeoutSeconds: bodyResult.data.timeoutSeconds,
					agentToken: bodyResult.data.agentToken,
					hostname: bodyResult.data.hostname,
					previewHostSuffix: bodyResult.data.previewHostSuffix,
					timezone: bodyResult.data.timezone,
					dockerGiB: bodyResult.data.dockerGiB,
					recoveryGiB: bodyResult.data.recoveryGiB,
					cpuAllowance: bodyResult.data.cpuAllowance,
					docker: bodyResult.data.docker,
				}),
			);
			request.log.info(
				{ instance: params.name, durationMs: Date.now() - started },
				"instance started",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post("/instances/:name/stop", async (request, reply) => {
		const params = request.params as { name: string };
		const nameResult = InstanceName.safeParse(params.name);
		if (!nameResult.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: "invalid instance name",
			});
		}
		const bodyResult = StopInstanceRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		const started = Date.now();
		try {
			const result = await singleFlight(`stop:${params.name}`, () =>
				provider.stop(params.name, {
					timeoutSeconds: bodyResult.data.timeoutSeconds,
				}),
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
			return sendError(reply, err);
		}
	});

	// Maintenance operations (ADR 0021). The worker stops the instance first;
	// the provider refuses a running one and this answers 409.
	app.post("/instances/:name/reset-docker", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		const bodyResult = ResetDockerRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		const started = Date.now();
		try {
			await singleFlight(`reset-docker:${params.name}`, () =>
				provider.resetDocker(params.name, { dockerGiB: bodyResult.data.dockerGiB }),
			);
			request.log.info(
				{ instance: params.name, durationMs: Date.now() - started },
				"docker reset",
			);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post("/instances/:name/rebuild", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		const bodyResult = RebuildInstanceRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		const started = Date.now();
		try {
			const result = await singleFlight(`rebuild:${params.name}`, () =>
				provider.rebuild(params.name, bodyResult.data),
			);
			request.log.info(
				{
					instance: params.name,
					resetDocker: bodyResult.data.resetDocker,
					durationMs: Date.now() - started,
				},
				"instance rebuilt",
			);
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
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
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		try {
			const processes = await singleFlight(`processes:${params.name}`, () =>
				provider.processes(params.name),
			);
			return reply.code(200).send({ processes });
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.put("/instances/:name/cpu-allowance", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		const bodyResult = SetCpuAllowanceRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		try {
			await provider.setCpuAllowance(params.name, bodyResult.data.allowance);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Per-workspace limits on the instance, never the profile (SPEC.md §19.3).
	app.put("/instances/:name/limits", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		const bodyResult = SetInstanceLimitsRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		try {
			await provider.setLimits(params.name, bodyResult.data);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The worker's daily package survey reads the apt hook's list (SPEC.md §20.1).
	app.get("/instances/:name/added-packages", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		try {
			return reply.code(200).send(await provider.addedPackages(params.name));
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// Swap an imported home in, keeping the old one (ADR 0021's pattern).
	app.post("/instances/:name/replace-home", async (request, reply) => {
		const params = request.params as { name: string };
		if (!InstanceName.safeParse(params.name).success) {
			return reply
				.code(400)
				.send({ code: "INVALID_NAME", message: "invalid instance name" });
		}
		const started = Date.now();
		try {
			const result = await singleFlight(`replace-home:${params.name}`, () =>
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
		if (!InstanceName.safeParse(params.name).success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: "invalid instance name",
			});
		}
		const bodyResult = GrowVolumesRequest.safeParse(request.body ?? {});
		if (!bodyResult.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: bodyResult.error.issues.map((i) => i.message).join("; "),
			});
		}
		try {
			const result = await provider.growVolumes(params.name, bodyResult.data);
			request.log.info({ instance: params.name, ...result }, "volumes grown");
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// The Docker seed: one build at a time, polled by the worker.
	const seedBuilds = opts.seedBuilds ?? new SeedBuilds(provider, rootLogger);

	app.post("/docker-seed/builds", async (request, reply) => {
		const parsed = SeedBuildRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: parsed.error.issues.map((i) => i.message).join("; "),
			});
		}
		try {
			return reply.code(202).send(seedBuilds.start(parsed.data));
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
): unknown {
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
