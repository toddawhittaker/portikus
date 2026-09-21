import {
	type ControllerErrorCode,
	CreateInstanceRequest,
	InstanceName,
	SetLogLevelRequest,
	StartInstanceRequest,
	StopInstanceRequest,
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
import { IncusError } from "./incus.js";
import type { WorkspaceProvider } from "./provider.js";

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
};

interface ServerOptions {
	provider: WorkspaceProvider;
	token: string;
	/** The process logger. Tests default to one that writes nothing. */
	logger?: Logger;
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
	registerRequestLogging(app, { debugPaths: ["/health"] });

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

	app.get("/instances", async (_request, reply) => {
		try {
			const result = await provider.list();
			return reply.code(200).send(result);
		} catch (err) {
			return sendError(reply, err);
		}
	});

	return app;
}

function sendError(
	reply: { code: (n: number) => { send: (b: unknown) => unknown } },
	err: unknown,
): unknown {
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
