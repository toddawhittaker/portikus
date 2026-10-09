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
	STOP_FAILED_ERROR_CODE,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Insertable, sql } from "kysely";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { lifecycleLimit } from "../rate-limit.js";
import {
	findOwnedWorkspace,
	findWorkspaceOwnedBy,
	fromJson,
	workspaceView,
} from "../workspaces/workspace-view.js";

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

	// Idempotent create for the signed-in user.
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
			return reply.status(200).send(await workspaceView(db, config, existing));
		}

		// Generate id and instance name.
		const id = crypto.randomUUID();
		const hexPrefix = id.replace(/-/g, "").slice(0, 24);
		const incusInstanceName = `ws-${hexPrefix}`;

		// The label is derived once, at creation, from the login username
		// (BROWSER-HANDLING.md section 8).
		const owner = await db
			.selectFrom("users")
			.select(["preferred_username", "email", "oidc_issuer", "oidc_subject"])
			.where("id", "=", ownerUserId)
			.executeTakeFirst();
		const hex = randomHex8();
		const hexLabel = `ws-${hex}`;
		// A course (LTI) account falls back to its email's local part, then its
		// LTI user ID, never random hex.
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
				return reply.status(200).send(await workspaceView(db, config, row));
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
		return reply.status(201).send(await workspaceView(db, config, created));
	});

	app.get("/workspaces/:id", async (request, reply) => {
		const user = requireUser(request);

		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;

		const row = await findOwnedWorkspace(db, user, params.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		return workspaceView(db, config, row);
	});

	app.post("/workspaces/:id/start", async (request, reply) => {
		return setDesired(request, reply, "running", "workspace.start_requested");
	});

	app.post("/workspaces/:id/stop", async (request, reply) => {
		return setDesired(request, reply, "stopped", "workspace.stop_requested");
	});

	app.post("/workspaces/:id/restart", async (request, reply) => {
		return setDesired(request, reply, "restarting", "workspace.restart_requested");
	});

	// Hold the workspace up until a time.
	// Only the owner: an administrator's hold would be impersonation.
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
		return workspaceView(db, config, updated);
	});

	// End the hold early. The
	// timers start again from now, as if the student had just acted. With no
	// hold left (it may have just expired) nothing changes.
	// jscpd:ignore-start -- each route spells out its own checks, in order.
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
			return workspaceView(db, config, row);
		}
		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: params.id,
			action: "workspace.keep_running_ended",
			result: "ok",
			metadata: { reason: "ended_early" },
		});
		return workspaceView(db, config, updated);
	});
	// jscpd:ignore-end

	// Helper: set desired_state and write audit
	async function setDesired(
		request: FastifyRequest,
		reply: FastifyReply,
		desired: DesiredState,
		action: string,
	): Promise<FastifyReply | undefined> {
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
				// A student's Start, Stop or Restart earns a fresh set of
				// automatic start retries (SPEC.md §6.3).
				start_retries: 0,
				// A new Stop lets the worker try a failed stop again (SPEC.md §6.5).
				...(desired === "stopped"
					? {
							error_code: sql<
								string | null
							>`case when error_code = ${STOP_FAILED_ERROR_CODE} then null else error_code end`,
						}
					: {}),
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

		return reply.status(202).send({ ok: true });
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
 * the same label. When those run out, each `lastResort`
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
