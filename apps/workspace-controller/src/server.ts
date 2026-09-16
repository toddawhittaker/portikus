import {
	type ControllerErrorCode,
	CreateInstanceRequest,
	InstanceName,
	StopInstanceRequest,
} from "@portikus/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { tokenAuth } from "./auth.js";
import { IncusError } from "./incus.js";
import type { WorkspaceProvider } from "./provider.js";

const ERROR_STATUS: Record<ControllerErrorCode, number> = {
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
}

export function buildServer(opts: ServerOptions): FastifyInstance {
	const { provider, token } = opts;
	const app = Fastify({ logger: false });

	app.addHook("preHandler", tokenAuth(token));

	const inflight = new Map<string, Promise<unknown>>();

	function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const existing = inflight.get(key);
		if (existing) {
			return existing as Promise<T>;
		}
		const promise = fn().finally(() => {
			inflight.delete(key);
		});
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

	app.post("/instances", async (request, reply) => {
		const parsed = CreateInstanceRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply.code(400).send({
				code: "INVALID_NAME",
				message: parsed.error.issues.map((i) => i.message).join("; "),
			});
		}
		try {
			const result = await provider.create(parsed.data.name, {
				homeGiB: parsed.data.homeGiB,
				dockerGiB: parsed.data.dockerGiB,
			});
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
		const body = (request.body ?? {}) as Record<string, unknown>;
		const timeout =
			typeof body.timeoutSeconds === "number" &&
			Number.isInteger(body.timeoutSeconds) &&
			body.timeoutSeconds > 0
				? body.timeoutSeconds
				: 60;
		try {
			const result = await singleFlight(`start:${params.name}`, () =>
				provider.start(params.name, {
					timeoutSeconds: timeout,
				}),
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
		try {
			const result = await singleFlight(`stop:${params.name}`, () =>
				provider.stop(params.name, {
					timeoutSeconds: bodyResult.data.timeoutSeconds,
				}),
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
	return reply
		.code(500)
		.send({ code: "OPERATION_FAILED", message: "unexpected error" });
}
