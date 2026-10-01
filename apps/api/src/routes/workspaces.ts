import { isCourseIssuer, requireUser } from "@portikus/auth";
import {
	CreateWorkspaceRequest,
	DEFAULT_KEEP_RUNNING_MAX_HOURS,
	type DesiredState,
	deriveWorkspaceLabel,
	type GuardConfig,
	keepRunningMaxHours,
	keepRunningRefusal,
	MAX_WORKSPACE_LABEL_LENGTH,
	SetKeepRunningRequest,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Insertable, sql } from "kysely";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { lifecycleLimit } from "../rate-limit.js";
import type { ServerDeps } from "../server.js";
import {
	countActive,
	findOwnedWorkspace,
	findWorkspaceOwnedBy,
	fromJson,
	loadWorkspaceSettings,
	toWorkspace,
} from "./workspace-view.js";

/** Eight random hex characters for the fallback workspace label. */
function randomHex8(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
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
			const active = await countActive(db, existing.id, config);
			return reply
				.status(200)
				.send(
					await toWorkspace(existing, active, config, await loadWorkspaceSettings(db)),
				);
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
				const active = await countActive(db, row.id, config);
				return reply
					.status(200)
					.send(
						await toWorkspace(row, active, config, await loadWorkspaceSettings(db)),
					);
			}
			throw err;
		}

		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: id,
			action: "workspace.provision_requested",
			result: "ok",
		});

		const created = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return reply
			.status(201)
			.send(await toWorkspace(created, 0, config, await loadWorkspaceSettings(db)));
	});

	// GET /workspaces/:id
	app.get("/workspaces/:id", async (request, reply) => {
		const user = requireUser(request);

		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;

		const row = await findOwnedWorkspace(db, user, params.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const active = await countActive(db, params.id, config);
		return toWorkspace(row, active, config, await loadWorkspaceSettings(db));
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

	// PUT /workspaces/:id/keep-running -- hold the workspace up until a time
	// (#955). Only the owner: an administrator's hold would be impersonation.
	app.put("/workspaces/:id/keep-running", async (request, reply) => {
		const user = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const row = await findWorkspaceOwnedBy(db, params.id, user.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		const body = SetKeepRunningRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const settings = await db
			.selectFrom("settings")
			.select("keep_running_max_hours")
			.where("id", "=", 1)
			.executeTakeFirst();
		const maxHours = keepRunningMaxHours(
			settings?.keep_running_max_hours ?? DEFAULT_KEEP_RUNNING_MAX_HOURS,
			fromJson<GuardConfig>(row.guard_config),
		);
		const now = new Date();
		const requested = new Date(body.data.until);
		const refusal = keepRunningRefusal(requested, now, maxHours);
		if (refusal === "off") {
			return sendError(
				reply,
				409,
				"KEEP_RUNNING_OFF",
				"Keeping a workspace running is turned off.",
			);
		}
		if (refusal === "past") {
			return sendError(reply, 400, "VALIDATION_FAILED", "Pick a time in the future.");
		}
		if (refusal === "too-far") {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`Pick a time no more than ${maxHours} hours from now.`,
			);
		}
		// A browser clock a little fast lands just past the cap; hold to the cap.
		const until = new Date(
			Math.min(requested.getTime(), now.getTime() + maxHours * 3_600_000),
		);
		const previous = row.keep_running_until as Date | null;
		// Setting a hold is the student acting, so any "Still working?" is answered.
		const updated = await db
			.updateTable("workspaces")
			.set({
				keep_running_until: until.toISOString(),
				last_activity_at: now.toISOString(),
				idle_stop_at: null,
				updated_at: now.toISOString(),
			})
			.where("id", "=", params.id)
			.returningAll()
			.executeTakeFirstOrThrow();
		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: params.id,
			action: "workspace.keep_running_set",
			result: "ok",
			metadata: {
				until: until.toISOString(),
				previousUntil:
					previous && previous > now ? new Date(previous).toISOString() : null,
			},
		});
		const active = await countActive(db, params.id, config);
		return toWorkspace(updated, active, config, await loadWorkspaceSettings(db));
	});

	// DELETE /workspaces/:id/keep-running -- end the hold early (#955). The
	// timers start again from now, as if the student had just acted. With no
	// hold left (it may have just expired) nothing changes.
	app.delete("/workspaces/:id/keep-running", async (request, reply) => {
		const user = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const row = await findWorkspaceOwnedBy(db, params.id, user.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		const now = new Date();
		const updated = await db
			.updateTable("workspaces")
			.set({
				keep_running_until: null,
				last_activity_at: now.toISOString(),
				idle_stop_at: null,
				disconnected_at: sql`case when disconnected_at is null then null else ${now.toISOString()}::timestamptz end`,
				updated_at: now.toISOString(),
			})
			.where("id", "=", params.id)
			.where("keep_running_until", ">", now)
			.returningAll()
			.executeTakeFirst();
		if (!updated) {
			return toWorkspace(
				row,
				await countActive(db, params.id, config),
				config,
				await loadWorkspaceSettings(db),
			);
		}
		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: params.id,
			action: "workspace.keep_running_ended",
			result: "ok",
			metadata: { reason: "ended_early" },
		});
		const active = await countActive(db, params.id, config);
		return toWorkspace(updated, active, config, await loadWorkspaceSettings(db));
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

		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;

		const row = await findOwnedWorkspace(db, user, params.id);
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
			.where("id", "=", params.id)
			.execute();

		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: params.id,
			action,
			result: "ok",
		});

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
			if (!isUniqueViolation(err, LABEL_INDEX)) throw err;
		}
	}
	throw new Error(`could not find a free workspace label starting from ${baseLabel}`);
}
