import { join } from "node:path";
import {
	CodingAgentsFile,
	IMAGE_JOB_STALE_MS,
	IMAGE_JOB_SYSTEM_REQUESTER,
	type ImageJobView,
	isJobActive,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { readJson, removeStaleRequests } from "../job-files.js";
import {
	allImageJobs,
	imageJobLock,
	newerCodingAgentsOf,
	queueImageJob,
} from "./image-jobs.js";
import { readPublished } from "./release-notices.js";

/** The nightly run starts in this hour of the server's local time, when few students work. */
export const AUTO_UPDATE_HOUR = 3;
/** Short enough that one tick always lands inside the hour. */
const TICK_MS = 15 * 60_000;

export type AutoUpdateDecision =
	| "off"
	| "not-tonight"
	| "tried-tonight"
	| "up-to-date"
	| "busy"
	| "start";

/** Midnight before `now`, server local time: the start of tonight's single attempt. */
function startOfNight(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Whether to start `agents-update` now (SPEC.md section 22.6). One attempt
 * per night, so a failing update cannot loop; a failure the night before
 * does not stop tonight's attempt.
 */
export function decideAgentsAutoUpdate(input: {
	enabled: boolean;
	now: Date;
	lastAttemptAt: Date | null;
	newer: { claude: string | null; codex: string | null };
	jobs: readonly ImageJobView[];
}): AutoUpdateDecision {
	if (!input.enabled) return "off";
	if (input.now.getHours() !== AUTO_UPDATE_HOUR) return "not-tonight";
	if (input.lastAttemptAt && input.lastAttemptAt >= startOfNight(input.now)) {
		return "tried-tonight";
	}
	if (!input.newer.claude && !input.newer.codex) return "up-to-date";
	const now = input.now.getTime();
	if (input.jobs.some((job) => isJobActive(job, IMAGE_JOB_STALE_MS, now)))
		return "busy";
	return "start";
}

/** When the system last asked for an agents update, from the audit log. */
async function lastAttemptAt(db: Kysely<Database>): Promise<Date | null> {
	const row = await db
		.selectFrom("audit_events")
		.select("at")
		.where("action", "=", "image.job_requested")
		.where("actor", "=", IMAGE_JOB_SYSTEM_REQUESTER)
		.orderBy("at", "desc")
		.limit(1)
		.executeTakeFirst();
	return row ? new Date(row.at) : null;
}

/** Decide, and queue the job when the decision is to start; returns the decision. */
export async function runAgentsAutoUpdate(
	db: Kysely<Database>,
	jobsDir: string,
	imagesDir: string,
	now: Date = new Date(),
): Promise<AutoUpdateDecision> {
	const settings = await db
		.selectFrom("settings")
		.select("coding_agents_auto_update")
		.where("id", "=", 1)
		.executeTakeFirst();
	const enabled = settings?.coding_agents_auto_update ?? false;
	if (!enabled || now.getHours() !== AUTO_UPDATE_HOUR) {
		return decideAgentsAutoUpdate({
			enabled,
			now,
			lastAttemptAt: null,
			newer: { claude: null, codex: null },
			jobs: [],
		});
	}
	if (imageJobLock.held) return "busy";
	imageJobLock.held = true;
	try {
		const jobs = await allImageJobs(jobsDir);
		const decision = decideAgentsAutoUpdate({
			enabled,
			now,
			lastAttemptAt: await lastAttemptAt(db),
			newer: newerCodingAgentsOf(
				await readPublished(imagesDir),
				await readJson(join(imagesDir, "coding-agents.json"), CodingAgentsFile),
			),
			jobs,
		});
		if (decision !== "start") return decision;
		await removeStaleRequests(jobsDir, jobs, IMAGE_JOB_STALE_MS);
		await queueImageJob(
			db,
			jobsDir,
			{ kind: "agents-update" },
			IMAGE_JOB_SYSTEM_REQUESTER,
		);
		return decision;
	} finally {
		imageJobLock.held = false;
	}
}

/** Check now and every quarter hour; errors are logged, never thrown. */
export function startAgentsAutoUpdate(options: {
	db: Kysely<Database>;
	logger: Logger;
	jobsDir: string;
	imagesDir: string;
}): () => void {
	const { db, logger, jobsDir, imagesDir } = options;
	const tick = async (): Promise<void> => {
		try {
			const decision = await runAgentsAutoUpdate(db, jobsDir, imagesDir);
			if (decision === "start") logger.info("nightly coding agents update requested");
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "coding agents auto-update error");
		}
	};
	const timer = setInterval(() => void tick(), TICK_MS);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
