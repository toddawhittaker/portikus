import { requireUser } from "@portikus/auth";
import {
	type ApiError,
	CreateWorkspaceRequest,
	type DesiredState,
	deriveWorkspaceLabel,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Insertable } from "kysely";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { countActive, findOwnedWorkspace, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

/** Eight random hex characters for the fallback workspace label. */
function randomHex8(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

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
		const user = requireUser(request);

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

		// The label is derived once, at creation, from the login username
		// (SPEC.md Epic 8; BROWSER-HANDLING.md section 8).
		const owner = await db
			.selectFrom("users")
			.select("preferred_username")
			.where("id", "=", ownerUserId)
			.executeTakeFirst();
		const baseLabel = deriveWorkspaceLabel(
			owner?.preferred_username ?? null,
			randomHex8(),
		);

		try {
			await insertWithLabel(db, baseLabel, {
				id,
				owner_user_id: ownerUserId,
				incus_instance_name: incusInstanceName,
				state: "provisioning",
				desired_state: "stopped",
				quota_config: JSON.stringify({
					homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
					dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
				}),
			});
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
		const user = requireUser(request);

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
		const user = requireUser(request);

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

/** How many `-2`, `-3`, ... suffixes to try before giving up on a label. */
const MAX_LABEL_ATTEMPTS = 20;

/** Postgres names the unique index over `workspaces.label`. */
const LABEL_INDEX = "idx_workspaces_label";

/**
 * Insert the workspace, appending `-2`, `-3`, ... when two students derive
 * the same label from their usernames (SPEC.md Epic 8).
 */
async function insertWithLabel(
	db: ServerDeps["db"],
	baseLabel: string,
	values: Omit<Insertable<Database["workspaces"]>, "label">,
): Promise<void> {
	for (let attempt = 1; attempt <= MAX_LABEL_ATTEMPTS; attempt++) {
		const label = attempt === 1 ? baseLabel : `${baseLabel}-${attempt}`;
		try {
			await db
				.insertInto("workspaces")
				.values({ ...values, label })
				.execute();
			return;
		} catch (err: unknown) {
			if (!isUniqueViolationOn(err, LABEL_INDEX)) throw err;
		}
	}
	throw new Error(`could not find a free workspace label starting from ${baseLabel}`);
}

function isUniqueViolationOn(err: unknown, constraint: string): boolean {
	return (
		isUniqueViolation(err) && (err as { constraint?: string }).constraint === constraint
	);
}

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: string }).code === "23505"
	);
}
