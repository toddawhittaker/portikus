/**
 * The agent's recovery point routes (SPEC.md §15, ADR 0020). Every id is a
 * uuid before it becomes part of a path. Logs carry ids, sizes and reasons
 * only, never file names or paths (ADR 0012).
 */
import {
	AgentCreateRecoveryPointRequest,
	AgentRecoveryDiffQuery,
	AgentRestoreRecoveryPointRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { abortOnDisconnect, sendError } from "./errors.js";
import {
	createRecoveryPoint,
	deleteProjectRecoveryPoints,
	deleteRecoveryPoint,
	listRecoveryArchives,
	RecoveryLocks,
	type RecoveryPaths,
	restoreRecoveryPoint,
} from "./recovery.js";
import { recoveryPointDiff } from "./recovery-diff.js";

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

export async function recoveryRoutes(
	instance: FastifyInstance,
	paths: RecoveryPaths,
): Promise<void> {
	const locks = new RecoveryLocks();

	instance.post("/projects/:slug/recovery-points", async (request, reply) => {
		const params = SlugParams.safeParse(request.params);
		const body = AgentCreateRecoveryPointRequest.safeParse(request.body);
		if (!params.success || !body.success) {
			return reply.code(400).send(badRequest());
		}
		const { projectId, pointId, skipIfFingerprint } = body.data;
		// A caller that gives up stops tar, which removes the partial file and
		// frees the project's lock.
		const aborted = abortOnDisconnect(reply);
		try {
			const result = await locks.run(projectId, async () => {
				const made = await createRecoveryPoint(
					paths,
					{ slug: params.data.slug, projectId, pointId, skipIfFingerprint },
					aborted,
				);
				// Nobody will record this point, so it must not stay on disk.
				if (made.created && aborted.aborted) {
					await deleteRecoveryPoint(paths.recoveryRoot, projectId, pointId);
				}
				return made;
			});
			if (aborted.aborted) {
				request.log.info(
					{ projectId, pointId },
					"recovery point abandoned by the caller",
				);
				return reply;
			}
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
			if (aborted.aborted) {
				request.log.info(
					{ projectId, pointId },
					"recovery point abandoned by the caller",
				);
				return reply;
			}
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

	// Read-only, so it takes no project lock: a restore running beside it
	// swaps the project, never the archive (SPEC.md §15.8).
	instance.get(
		"/projects/:slug/recovery-points/:pointId/diff",
		async (request, reply) => {
			const params = RestoreParams.safeParse(request.params);
			const query = AgentRecoveryDiffQuery.safeParse(request.query);
			if (!params.success || !query.success) {
				return reply.code(400).send(badRequest());
			}
			try {
				return await recoveryPointDiff(paths, {
					slug: params.data.slug,
					pointId: params.data.pointId,
					...query.data,
				});
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		},
	);

	instance.get("/recovery-points", async (request, reply) => {
		try {
			const archives = await listRecoveryArchives(paths.recoveryRoot);
			return reply.code(200).send({ archives });
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

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
