import {
	SITE_JOB_STALE_MS,
	type SiteJobBody,
	type SiteJobView,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { sendError } from "../http.js";
import { removeStaleRequests } from "../job-files.js";
import { allSiteJobs, requestSiteJob, siteJobBlock } from "./jobs.js";

// One API process: this closes the gap between checking and writing.
let writing = false;

const SITE_BUSY_MESSAGE = "A site change is already waiting or running.";
const SITE_TRIAL_MESSAGE = "A trial is open. Keep it or put it back first.";

/**
 * Write a request for the root site job unless another is waiting, running
 * or (for an address or sign-in change) on trial. Returns the job, or null
 * after answering 409 SITE_JOB_BUSY with why not.
 *
 * Dead queued requests are removed first: the root job takes requests
 * oldest first, so one left in place would run instead of this one.
 */
export async function submitSiteJob(
	reply: FastifyReply,
	db: Kysely<Database>,
	dir: string,
	actor: string,
	body: SiteJobBody,
): Promise<SiteJobView | null> {
	const refused = (message: string) => {
		sendError(reply, 409, "SITE_JOB_BUSY", message);
		return null;
	};
	if (writing) return refused(SITE_BUSY_MESSAGE);
	writing = true;
	try {
		const jobs = await allSiteJobs(dir);
		const block = siteJobBlock(body.kind, jobs);
		if (block) {
			return refused(block === "trial_open" ? SITE_TRIAL_MESSAGE : SITE_BUSY_MESSAGE);
		}
		await removeStaleRequests(dir, jobs, SITE_JOB_STALE_MS);
		return await requestSiteJob(db, dir, actor, body);
	} finally {
		writing = false;
	}
}
