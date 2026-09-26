import { isCourseIssuer, requireUser } from "@portikus/auth";
import {
	type ApiError,
	CreateWorkspaceRequest,
	type DesiredState,
	deriveWorkspaceLabel,
	MAX_WORKSPACE_LABEL_LENGTH,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Insertable } from "kysely";
import { z } from "zod";
import { lifecycleLimit } from "../rate-limit.js";
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
	const limitLifecycle = lifecycleLimit(config);

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
			.select(["preferred_username", "email", "oidc_issuer", "oidc_subject"])
			.where("id", "=", ownerUserId)
			.executeTakeFirst();
		const hex = randomHex8();
		const hexLabel = `ws-${hex}`;
		// A course (LTI) account falls back to its email's local part, then its
		// LTI user ID, never random hex (SPEC.md, Epic 8).
		const isCourse = owner !== undefined && isCourseIssuer(owner.oidc_issuer);
		const subLabel = isCourse
			? deriveWorkspaceLabel(owner.oidc_subject, hex)
			: hexLabel;
		const emailLocal = isCourse ? (owner.email?.split("@")[0] ?? null) : null;
		const emailLabel = deriveWorkspaceLabel(emailLocal, hex);
		const username = deriveWorkspaceLabel(owner?.preferred_username ?? null, hex);
		const baseLabel =
			[username, emailLabel, subLabel].find((label) => label !== hexLabel) ?? hexLabel;
		const lastResort = [...new Set([emailLabel, subLabel, hexLabel])].filter(
			(label) => label !== baseLabel,
		);

		try {
			await insertWithLabel(db, baseLabel, lastResort, {
				id,
				owner_user_id: ownerUserId,
				incus_instance_name: incusInstanceName,
				state: "provisioning",
				desired_state: "stopped",
				quota_config: JSON.stringify({
					homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
					dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
					recoveryGiB: config.WORKSPACE_RECOVERY_SIZE_GIB,
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
		if (!(await limitLifecycle(request, reply))) return;

		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const row = await findOwnedWorkspace(db, user, params.data.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		// Stopping an archived workspace is fine; starting it is not (SPEC.md §20.1).
		if (desired !== "stopped" && row.archived_at) {
			return sendError(
				reply,
				409,
				"WORKSPACE_ARCHIVED",
				"This workspace was archived by an administrator.",
			);
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

/** `base` with `-<attempt>` appended, shortened so the whole stays within the label cap. */
function suffixedLabel(base: string, attempt: number): string {
	if (attempt === 1) return base;
	const suffix = `-${attempt}`;
	const head = base
		.slice(0, MAX_WORKSPACE_LABEL_LENGTH - suffix.length)
		.replace(/-+$/g, "");
	return `${head}${suffix}`;
}

/**
 * Insert the workspace, appending `-2`, `-3`, ... when two students derive
 * the same label (SPEC.md Epic 8). When those run out, each `lastResort`
 * label is tried once.
 */
async function insertWithLabel(
	db: ServerDeps["db"],
	baseLabel: string,
	lastResort: string[],
	values: Omit<Insertable<Database["workspaces"]>, "label">,
): Promise<void> {
	const labels = [];
	for (let attempt = 1; attempt <= MAX_LABEL_ATTEMPTS; attempt++) {
		labels.push(suffixedLabel(baseLabel, attempt));
	}
	labels.push(...lastResort);
	for (const label of labels) {
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
