import {
	loginCookieName,
	loginCookieOptions,
	requireRole,
	requireUser,
} from "@portikus/auth";
import {
	type AdminSignin,
	SITE_JOB_STALE_MS,
	SigninSettings,
	type SiteJobBody,
	type SiteJobView,
	TrialRef,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { toAuthOptions } from "../auth-options.js";
import type { ServerDeps } from "../deps.js";
import { parseFieldsOr400, sendError, sendNoStoreError } from "../http.js";
import { currentJob } from "../job-files.js";
import { allSiteJobs, noteSiteJobsFinished } from "../site/jobs.js";
import {
	latestSigninTest,
	needsNewSecret,
	providerConnector,
	type SigninTestMarker,
} from "../site/signin.js";
import { submitSiteJob } from "../site/submit.js";
import { readSiteView } from "../site/view.js";

const adminOnly = { preHandler: requireRole("administrator") };

const UNAVAILABLE =
	"The sign-in provider can be changed here only on a server installed with apt.";
const NO_TRIAL = "That sign-in trial is no longer open.";
const SECRET_REQUIRED =
	"Enter the client secret: a changed provider, tenant, issuer or client ID never gets the old one.";
const TEST_REQUIRED = "Run a test sign-in that passes before keeping this change.";

/** A sign-in trial's job, or a waiting one whose kind is not known yet. */
function signinJobs(jobs: SiteJobView[]): SiteJobView[] {
	return jobs.filter((job) => job.kind === "signin" || job.kind === null);
}

/** Choosing the sign-in provider as a trial, checked by a test sign-in (SPEC.md 20.1, ADR 0059). */
export function registerAdminSigninRoutes(
	app: FastifyInstance,
	{ db, config, oidc }: ServerDeps,
): void {
	const jobsDir = config.SITE_JOBS_DIR;
	const auth = toAuthOptions(config);

	app.get("/admin/signin", adminOnly, async (_request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const view = await readSiteView(config.SITE_VIEW_FILE);
		const jobs = await allSiteJobs(jobsDir);
		await noteSiteJobsFinished(db, jobs);
		const out: AdminSignin = {
			current: view?.apt
				? {
						provider: view.provider,
						entraTenantId: view.entraTenantId,
						googleDomains: view.googleDomains,
						oidcIssuer: view.oidcIssuer,
						clientId: view.clientId,
						clientSecretSet: view.clientSecretSet,
						groupsClaim: view.groupsClaim,
						groups: view.groups,
						...(view.ldapHost === undefined ? {} : { ldapHost: view.ldapHost }),
					}
				: null,
			job: currentJob(signinJobs(jobs), SITE_JOB_STALE_MS),
			lastTest: await latestSigninTest(db),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	/** The open sign-in trial named by the body, or null after answering. */
	async function openTrial(dir: string, body: unknown, reply: FastifyReply) {
		const ref = TrialRef.safeParse(body ?? {});
		if (!ref.success) {
			sendError(reply, 400, "VALIDATION_FAILED", "Name the trial to end.");
			return null;
		}
		const trial = (await allSiteJobs(dir)).find(
			(job) =>
				job.id === ref.data.trialId && job.kind === "signin" && job.state === "trial",
		);
		if (!trial) sendError(reply, 409, "SITE_NO_OPEN_TRIAL", NO_TRIAL);
		return trial ?? null;
	}

	/** Write the request unless a job is waiting, running or, for a change, on trial. */
	async function submit(
		reply: FastifyReply,
		dir: string,
		adminId: string,
		body: SiteJobBody,
	) {
		const out = await submitSiteJob(db, dir, `user:${adminId}`, body);
		if ("refused" in out) return sendError(reply, 409, "SITE_JOB_BUSY", out.refused);
		return reply.status(202).send(out.job);
	}

	app.post("/admin/signin", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const settings = parseFieldsOr400(SigninSettings, request.body ?? {}, reply);
		if (!settings) return reply;
		const view = await readSiteView(config.SITE_VIEW_FILE);
		if (!view?.apt) return sendError(reply, 409, "SITE_UNAVAILABLE", UNAVAILABLE);
		if (needsNewSecret(view, settings)) {
			return sendError(reply, 400, "SIGNIN_SECRET_REQUIRED", SECRET_REQUIRED);
		}
		return submit(reply, jobsDir, admin.id, { kind: "signin", ...settings });
	});

	app.post("/admin/signin/keep", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const trial = await openTrial(jobsDir, request.body, reply);
		if (!trial) return reply;
		// The view shows the trial's settings once its setup ran.
		const view = await readSiteView(config.SITE_VIEW_FILE);
		if (view?.provider !== "dex") {
			const test = await latestSigninTest(db);
			if (test?.trialId !== trial.id || test.result !== "passed") {
				return sendError(reply, 409, "SIGNIN_TEST_REQUIRED", TEST_REQUIRED);
			}
		}
		return submit(reply, jobsDir, admin.id, { kind: "keep", trialId: trial.id });
	});

	app.post("/admin/signin/rollback", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const trial = await openTrial(jobsDir, request.body, reply);
		if (!trial) return reply;
		return submit(reply, jobsDir, admin.id, { kind: "rollback", trialId: trial.id });
	});

	/**
	 * Start a test sign-in through the provider in force, the trial's while one
	 * is open. The callback sees the marker in the signed login cookie and
	 * signs no one in (ADR 0059).
	 */
	app.get("/admin/signin/test", adminOnly, async (request, reply) => {
		if (!jobsDir || !oidc) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const view = await readSiteView(config.SITE_VIEW_FILE);
		if (!view?.apt)
			return sendNoStoreError(reply, 409, "SITE_UNAVAILABLE", UNAVAILABLE);
		const jobs = await allSiteJobs(jobsDir);
		const trial = jobs.find((job) => job.kind === "signin" && job.state === "trial");
		const connector = providerConnector(view.provider);
		const { url, state } = await oidc.buildLoginRedirect({
			prompt: "login",
			connectorId: connector,
		});
		const marker: SigninTestMarker = {
			adminId: admin.id,
			trialId: trial?.id ?? null,
			connector,
		};
		reply.setCookie(
			loginCookieName(auth),
			JSON.stringify({ ...state, signinTest: marker }),
			{
				...loginCookieOptions(auth),
				signed: true,
			},
		);
		return reply.header("cache-control", "no-store").redirect(url, 302);
	});
}
