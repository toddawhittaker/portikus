import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminProxyHosts,
	ProxyHostsUpdate,
	SITE_JOB_STALE_MS,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { currentJob } from "../job-files.js";
import { allSiteJobs, noteSiteJobsFinished } from "../site/jobs.js";
import { readOperatorProxyHosts, readPageProxyHosts } from "../site/page-files.js";
import { submitSiteJob } from "../site/submit.js";

const adminOnly = { preHandler: requireRole("administrator") };

/**
 * Host names the platform may reach through the egress proxy, added on the
 * page (SPEC.md 20.1, ADR 0059). The API writes one request file and reads
 * the page-owned list back; the root job changes Squid. With SITE_JOBS_DIR
 * unset the routes are 404.
 */
export function registerAdminProxyHostRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const jobsDir = config.SITE_JOBS_DIR;

	app.get("/admin/proxy-hosts", adminOnly, async (_request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const jobs = await allSiteJobs(jobsDir);
		await noteSiteJobsFinished(db, jobs);
		const out: AdminProxyHosts = {
			operatorHosts: await readOperatorProxyHosts(config.SQUID_CONF_FILE),
			hosts: await readPageProxyHosts(config.PROXY_HOSTS_FILE),
			job: currentJob(jobs, SITE_JOB_STALE_MS),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.put("/admin/proxy-hosts", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const body = ProxyHostsUpdate.safeParse(request.body ?? {});
		if (!body.success) {
			// Zod's issues can quote the input; only the field paths are named.
			const fields = [...new Set(body.error.issues.map((i) => i.path.join(".")))];
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`Check these fields: ${fields.join(", ") || "hosts"}.`,
			);
		}
		const hosts = [...new Set(body.data.hosts.map((host) => host.toLowerCase()))];
		const result = await submitSiteJob(db, jobsDir, `user:${admin.id}`, {
			kind: "proxy-hosts",
			hosts,
		});
		if ("refused" in result) {
			return sendError(reply, 409, "SITE_JOB_BUSY", result.refused);
		}
		return reply.status(202).send(result.job);
	});
}
