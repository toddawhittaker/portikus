import {
	type ApiError,
	type ConnectionCreated,
	CreateWorkspaceRequest,
	type Workspace,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { ServerDeps } from "../server.js";

const UuidParam = z.object({ id: z.string().uuid() });
const ConnectionParams = z.object({
	id: z.string().uuid(),
	cid: z.string().uuid(),
});

function sendError(
	reply: { status: (code: number) => { send: (body: ApiError) => void } },
	statusCode: number,
	code: ApiError["code"],
	message: string,
): void {
	reply.status(statusCode).send({ code, message });
}

/** Map a workspaces row to the Workspace contract shape. */
function toWorkspace(
	row: Record<string, unknown>,
	activeConnections: number,
): Workspace {
	const quota =
		typeof row.quota_config === "string"
			? JSON.parse(row.quota_config)
			: row.quota_config;
	return {
		id: row.id as string,
		ownerUserId: row.owner_user_id as string,
		state: row.state as Workspace["state"],
		desiredState: row.desired_state as Workspace["desiredState"],
		incusInstanceName: (row.incus_instance_name as string) ?? null,
		imageVersion: (row.image_version as string) ?? null,
		quotaConfig: quota ?? { homeGiB: 25, dockerGiB: 20 },
		errorCode: (row.error_code as string) ?? null,
		errorMessage: (row.error_message as string) ?? null,
		activeConnections,
		lastActiveConnectionAt: row.last_active_connection_at
			? (row.last_active_connection_at as Date).toISOString()
			: null,
		shutdownDeadline: row.shutdown_deadline
			? (row.shutdown_deadline as Date).toISOString()
			: null,
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
	};
}

export function registerWorkspaceRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	// POST /workspaces -- idempotent create by owner
	app.post("/workspaces", async (request, reply) => {
		const body = CreateWorkspaceRequest.safeParse(request.body);
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const { ownerUserId } = body.data;

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
				.send(toWorkspace(existing as Record<string, unknown>, active));
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
					.send(toWorkspace(row as Record<string, unknown>, active));
			}
			throw err;
		}

		// Write audit event.
		await db
			.insertInto("audit_events")
			.values({
				actor: "api",
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
		return reply.status(201).send(toWorkspace(created as Record<string, unknown>, 0));
	});

	// GET /workspaces/:id
	app.get("/workspaces/:id", async (request, reply) => {
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const row = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", params.data.id)
			.executeTakeFirst();

		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const active = await countActive(db, params.data.id, config);
		return toWorkspace(row as Record<string, unknown>, active);
	});

	// POST /workspaces/:id/start
	app.post("/workspaces/:id/start", async (request, reply) => {
		return setDesired(db, request, reply, "running", "workspace.start_requested");
	});

	// POST /workspaces/:id/stop
	app.post("/workspaces/:id/stop", async (request, reply) => {
		return setDesired(db, request, reply, "stopped", "workspace.stop_requested");
	});

	// POST /workspaces/:id/restart
	app.post("/workspaces/:id/restart", async (request, reply) => {
		return setDesired(db, request, reply, "restarting", "workspace.restart_requested");
	});

	// POST /workspaces/:id/connections
	app.post("/workspaces/:id/connections", async (request, reply) => {
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const workspace = await db
			.selectFrom("workspaces")
			.select("id")
			.where("id", "=", params.data.id)
			.executeTakeFirst();

		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const connectionId = crypto.randomUUID();

		await db
			.insertInto("workspace_connections")
			.values({
				id: connectionId,
				workspace_id: params.data.id,
			})
			.execute();

		await db
			.updateTable("workspaces")
			.set({
				desired_state: "running",
				last_active_connection_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", params.data.id)
			.execute();

		const body: ConnectionCreated = {
			connectionId,
			workspaceId: params.data.id,
		};
		return reply.status(201).send(body);
	});

	// POST /workspaces/:id/connections/:cid/heartbeat
	app.post("/workspaces/:id/connections/:cid/heartbeat", async (request, reply) => {
		const params = ConnectionParams.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const result = await db
			.updateTable("workspace_connections")
			.set({ last_seen_at: new Date().toISOString() })
			.where("id", "=", params.data.cid)
			.where("workspace_id", "=", params.data.id)
			.executeTakeFirst();

		if (result.numUpdatedRows === 0n) {
			return sendError(reply, 404, "CONNECTION_NOT_FOUND", "Connection not found");
		}

		return reply.status(204).send();
	});

	// DELETE /workspaces/:id/connections/:cid
	app.delete("/workspaces/:id/connections/:cid", async (request, reply) => {
		const params = ConnectionParams.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		await db
			.deleteFrom("workspace_connections")
			.where("id", "=", params.data.cid)
			.where("workspace_id", "=", params.data.id)
			.execute();

		return reply.status(204).send();
	});

	// Helper: set desired_state and write audit
	async function setDesired(
		db: ServerDeps["db"],
		request: { params: unknown },
		reply: {
			status: (code: number) => { send: (body: unknown) => void };
		},
		desired: string,
		action: string,
	): Promise<void> {
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(
				reply as Parameters<typeof sendError>[0],
				400,
				"VALIDATION_FAILED",
				params.error.message,
			);
		}

		const result = await db
			.updateTable("workspaces")
			.set({
				desired_state: desired,
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", params.data.id)
			.executeTakeFirst();

		if (result.numUpdatedRows === 0n) {
			return sendError(
				reply as Parameters<typeof sendError>[0],
				404,
				"WORKSPACE_NOT_FOUND",
				"Workspace not found",
			);
		}

		await db
			.insertInto("audit_events")
			.values({
				actor: "api",
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

async function countActive(
	db: ServerDeps["db"],
	workspaceId: string,
	config: ServerDeps["config"],
): Promise<number> {
	const cutoff = new Date(
		Date.now() - config.PRESENCE_TTL_SECONDS * 1000,
	).toISOString();

	const result = await db
		.selectFrom("workspace_connections")
		.select(sql<number>`count(*)::int`.as("count"))
		.where("workspace_id", "=", workspaceId)
		.where("last_seen_at", ">", sql<Date>`${cutoff}::timestamptz`)
		.executeTakeFirstOrThrow();

	return result.count;
}
