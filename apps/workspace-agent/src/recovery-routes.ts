/**
 * The agent's recovery point routes (SPEC.md §15, ADR 0020). Every id is a
 * uuid before it becomes part of a path. Logs carry ids, sizes and reasons
 * only, never file names or paths (ADR 0012).
 */
import {
	AgentCreateRecoveryPointRequest,
	AgentRestoreRecoveryPointRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "./errors.js";
import {
	createRecoveryPoint,
	deleteProjectRecoveryPoints,
	deleteRecoveryPoint,
	RecoveryLocks,
	type RecoveryPaths,
	restoreRecoveryPoint,
} from "./recovery.js";

const SlugParams = z.object({ slug: z.string() });
const RestoreParams = z.object({ slug: z.string(), pointId: z.string().uuid() });
const ProjectParams = z.object({ projectId: z.string().uuid() });
const PointParams = z.object({
	projectId: z.string().uuid(),
	pointId: z.string().uuid(),
});

function badRequest() {
	return { error: { code: "BAD_REQUEST", message: "invalid recovery point request" } };
}

export function registerRecoveryRoutes(
	instance: FastifyInstance,
	paths: RecoveryPaths,
): void {
	const locks = new RecoveryLocks();

	instance.post("/projects/:slug/recovery-points", async (request, reply) => {
		const params = SlugParams.safeParse(request.params);
		const body = AgentCreateRecoveryPointRequest.safeParse(request.body);
		if (!params.success || !body.success) {
			return reply.code(400).send(badRequest());
		}
		const { projectId, pointId, skipIfFingerprint } = body.data;
		try {
			const result = await locks.run(projectId, () =>
				createRecoveryPoint(paths, {
					slug: params.data.slug,
					projectId,
					pointId,
					skipIfFingerprint,
				}),
			);
			if (!result.created) {
				request.log.debug({ projectId }, "recovery point skipped, project unchanged");
				return reply.code(200).send(result);
			}
			request.log.info(
				{ projectId, pointId, sizeBytes: result.sizeBytes },
				"recovery point created",
			);
			return reply.code(201).send(result);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post(
		"/projects/:slug/recovery-points/:pointId/restore",
		async (request, reply) => {
			const params = RestoreParams.safeParse(request.params);
			const body = AgentRestoreRecoveryPointRequest.safeParse(request.body);
			if (!params.success || !body.success) {
				return reply.code(400).send(badRequest());
			}
			const { projectId, sha256 } = body.data;
			const { pointId } = params.data;
			try {
				await locks.run(projectId, () =>
					restoreRecoveryPoint(paths, {
						slug: params.data.slug,
						projectId,
						pointId,
						sha256,
					}),
				);
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
			request.log.info({ projectId, pointId }, "recovery point restored");
			return reply.code(204).send();
		},
	);

	instance.delete("/recovery-points/:projectId/:pointId", async (request, reply) => {
		const params = PointParams.safeParse(request.params);
		if (!params.success) {
			return reply.code(400).send(badRequest());
		}
		const { projectId, pointId } = params.data;
		try {
			await locks.run(projectId, () =>
				deleteRecoveryPoint(paths.recoveryRoot, projectId, pointId),
			);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
		return reply.code(204).send();
	});

	instance.delete("/recovery-points/:projectId", async (request, reply) => {
		const params = ProjectParams.safeParse(request.params);
		if (!params.success) {
			return reply.code(400).send(badRequest());
		}
		const { projectId } = params.data;
		try {
			await locks.run(projectId, () =>
				deleteProjectRecoveryPoints(paths.recoveryRoot, projectId),
			);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
		request.log.info({ projectId }, "recovery points of a project deleted");
		return reply.code(204).send();
	});
}
