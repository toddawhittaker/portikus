import type { SiteJobBody, SiteJobView } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { allSiteJobs, requestSiteJob, siteJobBlock } from "./jobs.js";

// One API process: this closes the gap between checking and writing.
let writing = false;

const SITE_BUSY_MESSAGE = "A site change is already waiting or running.";
const SITE_TRIAL_MESSAGE = "A trial is open. Keep it or put it back first.";

/**
 * Write a request for the root site job unless another is waiting, running
 * or (for an address or sign-in change) on trial. Returns the job, or why
 * not.
 */
export async function submitSiteJob(
	db: Kysely<Database>,
	dir: string,
	actor: string,
	body: SiteJobBody,
): Promise<{ job: SiteJobView } | { refused: string }> {
	if (writing) return { refused: SITE_BUSY_MESSAGE };
	writing = true;
	try {
		const block = siteJobBlock(body.kind, await allSiteJobs(dir));
		if (block) {
			return {
				refused: block === "trial_open" ? SITE_TRIAL_MESSAGE : SITE_BUSY_MESSAGE,
			};
		}
		return { job: await requestSiteJob(db, dir, actor, body) };
	} finally {
		writing = false;
	}
}
