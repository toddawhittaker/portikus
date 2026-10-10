import { requireRole, requireUser } from "@portikus/auth";
import {
	AddressSettings,
	type AdminAddress,
	SITE_JOB_STALE_MS,
	type SiteJobBody,
	type SiteJobView,
	type SiteView,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import {
	certificateStatusDirOf,
	readCertificateStatus,
} from "../certificate/notices.js";
import {
	type NonceStore,
	type PreflightNet,
	runAddressPreflight,
	systemNet,
} from "../certificate/preflight.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { currentJob } from "../job-files.js";
import {
	addressRefusal,
	hostHeader,
	nextPreviewSuffix,
	planAddress,
	type RunningWorkspace,
	uploadsCover,
} from "../site/address-plan.js";
import { allSiteJobs, noteSiteJobsFinished } from "../site/jobs.js";
import { submitSiteJob } from "../site/submit.js";
import { readSiteView } from "../site/view.js";

const adminOnly = { preHandler: requireRole("administrator") };

/** One readable sentence about the first thing wrong with the body; never the input itself. */
function settingsError(body: unknown): string | null {
	const parsed = AddressSettings.safeParse(body);
	if (parsed.success) return null;
	const issue = parsed.error.issues[0];
	const field = issue?.path.join(".") || "body";
	return `${field} ${issue?.message ?? "is not valid"}.`;
}

/**
 * Moving the site to a new host name or port as a trial (SPEC.md 20.1,
 * ADR 0059). The page plans the move, checks DNS, and asks
 * the root site job to switch; the administrator then keeps the trial from
 * the new address, or it is put back after 15 minutes. With SITE_JOBS_DIR
 * unset every route is 404.
 */
export function registerAdminAddressRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
	nonces: NonceStore,
	net: PreflightNet = systemNet,
): void {
	const jobsDir = config.SITE_JOBS_DIR;
	function off(reply: FastifyReply): boolean {
		if (jobsDir) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	/** The view, or null after answering that address changes are unavailable here. */
	async function aptView(reply: FastifyReply): Promise<SiteView | null> {
		const view = await readSiteView(config.SITE_VIEW_FILE);
		if (view?.apt) return view;
		sendError(
			reply,
			409,
			"SITE_UNAVAILABLE",
			"The site address can be changed here only on a server installed with apt. Use the install's own tools instead.",
		);
		return null;
	}

	/** Each requested address job's host and port, from its `site.job_requested` row. */
	async function requestedAddresses(
		ids: string[],
	): Promise<Map<string, AddressSettings>> {
		const found = new Map<string, AddressSettings>();
		if (ids.length === 0) return found;
		const rows = await db
			.selectFrom("audit_events")
			.select(["target", "metadata"])
			.where("action", "=", "site.job_requested")
			.where("target", "in", ids)
			.where(sql<string>`metadata->>'kind'`, "=", "address")
			.execute();
		for (const row of rows) {
			const parsed = AddressSettings.safeParse({
				host: row.metadata?.host,
				port: row.metadata?.port,
			});
			if (parsed.success) found.set(row.target, parsed.data);
		}
		return found;
	}

	/** The address job the page shows, with the address it asked for. */
	async function addressJob(
		jobs: SiteJobView[],
	): Promise<{ job: SiteJobView; target: AddressSettings | null } | null> {
		const requested = await requestedAddresses(jobs.map((j) => j.id));
		// A queued request's kind is unknown until the job takes it; the audit row says.
		const mine = jobs
			.filter((j) => j.kind === "address" || (j.kind === null && requested.has(j.id)))
			.map((j) => ({ ...j, kind: "address" as const }));
		const job = currentJob(mine, SITE_JOB_STALE_MS);
		return job ? { job, target: requested.get(job.id) ?? null } : null;
	}

	async function runningWorkspaces(): Promise<RunningWorkspace[]> {
		const rows = await db
			.selectFrom("workspaces")
			.innerJoin("users", "users.id", "workspaces.owner_user_id")
			.select(["workspaces.id", "workspaces.label", "users.display_name"])
			.where("workspaces.state", "=", "running")
			.orderBy("workspaces.label")
			.execute();
		return rows.map((r) => ({ id: r.id, label: r.label, ownerName: r.display_name }));
	}

	async function certificateStatus(view: SiteView) {
		if (view.certificateSource !== "files" || !config.CERTIFICATE_JOBS_DIR) return null;
		return readCertificateStatus(certificateStatusDirOf(config.CERTIFICATE_JOBS_DIR));
	}

	/** The parsed body and the view, or null after answering why not. */
	async function planInput(
		body: unknown,
		reply: FastifyReply,
	): Promise<{ view: SiteView; target: AddressSettings } | null> {
		const problem = settingsError(body);
		if (problem) {
			sendError(reply, 400, "VALIDATION_FAILED", problem);
			return null;
		}
		const target = AddressSettings.parse(body);
		const view = await aptView(reply);
		if (!view) return null;
		const refusal = addressRefusal(view, target);
		if (refusal) {
			sendError(reply, 400, "VALIDATION_FAILED", refusal);
			return null;
		}
		return { view, target };
	}

	/** Write a request through the shared site-job lock, or answer why it must wait. */
	async function submit(reply: FastifyReply, actor: string, body: SiteJobBody) {
		if (!jobsDir) return;
		const job = await submitSiteJob(reply, db, jobsDir, actor, body);
		if (!job) return reply;
		return reply
			.status(202)
			.header("cache-control", "no-store")
			.send({ ...job, kind: body.kind });
	}

	/** Write a keep or rollback request for the open address trial. */
	async function endTrial(
		kind: "keep" | "rollback",
		request: FastifyRequest,
		reply: FastifyReply,
	) {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		const trial = await addressJob(await allSiteJobs(jobsDir));
		if (trial?.job.state !== "trial") {
			return sendError(reply, 409, "SITE_NO_OPEN_TRIAL", "No address trial is open.");
		}
		if (kind === "keep") {
			// Keep proves the browser reaches the new address (ADR 0059).
			const wanted = trial.target ? hostHeader(trial.target) : null;
			const here = request.host.toLowerCase();
			const withoutDefault = here.endsWith(":443") ? here.slice(0, -4) : here;
			if (!wanted || withoutDefault !== wanted) {
				return sendError(
					reply,
					403,
					"FORBIDDEN",
					wanted
						? `Press Keep from the new address, https://${wanted}, to show it works.`
						: "The trial's new address is unknown, so it cannot be kept. Roll it back.",
				);
			}
		}
		return submit(reply, `user:${admin.id}`, { kind, trialId: trial.job.id });
	}

	app.get("/admin/address", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir) return;
		const view = await readSiteView(config.SITE_VIEW_FILE);
		const jobs = await allSiteJobs(jobsDir);
		await noteSiteJobsFinished(db, jobs);
		const found = await addressJob(jobs);
		const apt = view?.apt ?? false;
		const out: AdminAddress = {
			current:
				view && apt
					? {
							host: view.host,
							port: view.port,
							previewSuffix: view.previewSuffix,
							previewSuffixSetByHand: view.previewSuffixSetByHand,
							certificateSource: view.certificateSource,
						}
					: null,
			apt,
			target: found?.target ?? null,
			job: found?.job ?? null,
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.post("/admin/address/plan", adminOnly, async (request, reply) => {
		if (off(reply)) return;
		const input = await planInput(request.body, reply);
		if (!input) return;
		const plan = planAddress({
			...input,
			certificateStatus: await certificateStatus(input.view),
			running: await runningWorkspaces(),
		});
		return reply.header("cache-control", "no-store").send(plan);
	});

	app.post("/admin/address/preflight", adminOnly, async (request, reply) => {
		if (off(reply)) return;
		const input = await planInput(request.body, reply);
		if (!input) return;
		const result = await runAddressPreflight({
			config,
			net,
			nonces,
			host: input.target.host,
			previewSuffix: nextPreviewSuffix(input.view, input.target.host),
		});
		return reply.header("cache-control", "no-store").send(result);
	});

	app.post("/admin/address/apply", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		const input = await planInput(request.body, reply);
		if (!input) return;
		const { view, target } = input;
		if (
			view.certificateSource === "files" &&
			!uploadsCover(
				await certificateStatus(view),
				target.host,
				nextPreviewSuffix(view, target.host),
			)
		) {
			return sendError(
				reply,
				409,
				"CERTIFICATE_UPLOAD_REFUSED",
				"The uploaded certificate does not cover the new names. Upload one that does on the Certificate tab first.",
			);
		}
		return submit(reply, `user:${admin.id}`, { kind: "address", ...target });
	});

	app.post("/admin/address/keep", adminOnly, (request, reply) =>
		endTrial("keep", request, reply),
	);

	app.post("/admin/address/rollback", adminOnly, (request, reply) =>
		endTrial("rollback", request, reply),
	);
}
