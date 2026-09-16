import {
	type ApiError,
	CreateWorkspaceRequest,
	type DesiredState,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { countActive, findOwnedWorkspace, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): void {
	reply.status(statusCode).send({ code, message });
}

export function registerWorkspaceRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	// POST /workspaces -- idempotent create for the signed-in user
	app.post("/workspaces", async (request, reply) => {
		const user = request.user;
		if (!user) {
			return sendError(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}

		const body = CreateWorkspaceRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const ownerUserId = user.id;

		// Check for existing workspace first.
		const existing = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("owner_user_id", "=", ownerUserId)
			.executeTakeFirst();

		if (existing) {
			const active = await countActive(db, existing.id as string, config);
			return reply
				.status(200)
				.send(toWorkspace(existing as Record<string, unknown>, active, config));
		}

		// Generate id and instance name.
		const id = crypto.randomUUID();
		const hexPrefix = id.replace(/-/g, "").slice(0, 24);
		const incusInstanceName = `ws-${hexPrefix}`;

		try {
			await db
				.insertInto("workspaces")
				.values({
					id,
					owner_user_id: ownerUserId,
					incus_instance_name: incusInstanceName,
					state: "provisioning",
					desired_state: "stopped",
					quota_config: JSON.stringify({
						homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
						dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
					}),
				})
				.execute();
		} catch (err: unknown) {
			// Unique violation race: another request created it first.
			if (isUniqueViolation(err)) {
				const row = await db
					.selectFrom("workspaces")
					.selectAll()
					.where("owner_user_id", "=", ownerUserId)
					.executeTakeFirstOrThrow();
				const active = await countActive(db, row.id as string, config);
				return reply
					.status(200)
					.send(toWorkspace(row as Record<string, unknown>, active, config));
			}
			throw err;
		}

		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${user.id}`,
				target: id,
				action: "workspace.provision_requested",
				result: "ok",
			})
			.execute();

		const created = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return reply
			.status(201)
			.send(toWorkspace(created as Record<string, unknown>, 0, config));
	});

	// GET /workspaces/:id
	app.get("/workspaces/:id", async (request, reply) => {
		const user = request.user;
		if (!user) {
			return sendError(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}

		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const row = await findOwnedWorkspace(db, user, params.data.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const active = await countActive(db, params.data.id, config);
		return toWorkspace(row, active, config);
	});

	// POST /workspaces/:id/start
	app.post("/workspaces/:id/start", async (request, reply) => {
		return setDesired(request, reply, "running", "workspace.start_requested");
	});

	// POST /workspaces/:id/stop
	app.post("/workspaces/:id/stop", async (request, reply) => {
		return setDesired(request, reply, "stopped", "workspace.stop_requested");
	});

	// POST /workspaces/:id/restart
	app.post("/workspaces/:id/restart", async (request, reply) => {
		return setDesired(request, reply, "restarting", "workspace.restart_requested");
	});

	// Helper: set desired_state and write audit
	async function setDesired(
		request: FastifyRequest,
		reply: FastifyReply,
		desired: DesiredState,
		action: string,
	): Promise<void> {
		const user = request.user;
		if (!user) {
			return sendError(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}

		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const row = await findOwnedWorkspace(db, user, params.data.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		await db
			.updateTable("workspaces")
			.set({
				desired_state: desired,
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", params.data.id)
			.execute();

		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${user.id}`,
				target: params.data.id,
				action,
				result: "ok",
			})
			.execute();

		reply.status(202).send({ ok: true });
	}
}

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: string }).code === "23505"
	);
}
