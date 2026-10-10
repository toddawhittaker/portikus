import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminLmsPlatforms,
	LtiPlatformsUpdate,
	SITE_JOB_STALE_MS,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { currentJob } from "../job-files.js";
import { allSiteJobs, noteSiteJobsFinished } from "../site/jobs.js";
import { readOperatorPlatforms, readPagePlatforms } from "../site/page-files.js";
import { submitSiteJob } from "../site/submit.js";

const adminOnly = { preHandler: requireRole("administrator") };

/**
 * LMS platforms the page registers for LTI launches (SPEC.md 20.1, ADR
 * 0059). The API writes one request file; the root job checks it again,
 * updates Squid and restarts the API. With SITE_JOBS_DIR unset the routes
 * are 404.
 */
export function registerAdminLmsRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const jobsDir = config.SITE_JOBS_DIR;
	const site = new URL(config.PUBLIC_URL).origin;

	app.get("/admin/lms", adminOnly, async (_request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const jobs = await allSiteJobs(jobsDir);
		await noteSiteJobsFinished(db, jobs);
		const out: AdminLmsPlatforms = {
			toolUrls: {
				loginUrl: `${site}/lti/login`,
				launchUrl: `${site}/lti/launch`,
				keysetUrl: `${site}/lti/jwks`,
				deepLinkingUrl: `${site}/lti/launch`,
			},
			operatorPlatforms: await readOperatorPlatforms(config.LTI_PLATFORMS_FILE),
			platforms: await readPagePlatforms(config.LTI_ADMIN_PLATFORMS_FILE),
			job: currentJob(jobs, SITE_JOB_STALE_MS),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.put("/admin/lms", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const body = LtiPlatformsUpdate.safeParse(request.body ?? {});
		if (!body.success) {
			const fields = [...new Set(body.error.issues.map((i) => i.path.join(".")))];
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`Check these fields: ${fields.join(", ") || "platforms"}.`,
			);
		}
		const operator = await readOperatorPlatforms(config.LTI_PLATFORMS_FILE);
		const clash = body.data.platforms.find((p) =>
			operator.some(
				(o) =>
					o.name === p.name || (o.issuer === p.issuer && o.clientId === p.clientId),
			),
		);
		if (clash) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`${clash.name}: the operator's file already registers this name, or this issuer and client ID.`,
			);
		}
		const result = await submitSiteJob(db, jobsDir, `user:${admin.id}`, {
			kind: "lti-platforms",
			platforms: body.data.platforms,
		});
		if ("refused" in result) {
			return sendError(reply, 409, "SITE_JOB_BUSY", result.refused);
		}
		return reply.status(202).send(result.job);
	});
}
