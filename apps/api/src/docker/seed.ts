import { join } from "node:path";
import {
	ImageAliasesFile,
	ImageManifest,
	matchingSeedImages,
	type SeedMatch,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { readJson } from "../job-files.js";

/** The slim images matching the default workspace image, or null when its manifest is unreadable. */
export async function readMatch(imagesDir: string | null): Promise<SeedMatch | null> {
	if (!imagesDir) return null;
	const aliases = await readJson(join(imagesDir, "aliases.json"), ImageAliasesFile);
	if (!aliases?.default) return null;
	const manifest = await readJson(
		join(imagesDir, aliases.default, "manifest.json"),
		ImageManifest,
	);
	return manifest ? matchingSeedImages(manifest) : null;
}

export function matchedImages(match: SeedMatch | null): string[] {
	return [match?.node?.image, match?.python?.image].filter(
		(each): each is string => each !== undefined,
	);
}

export interface JobRow {
	id: string;
	state: string;
	step: string;
	images: string[];
	message: string | null;
	requested_at: Date;
	finished_at: Date | null;
}

/** Queue a seed rebuild; a unique index refuses a second waiting or running job. */
export function insertJob(
	db: Kysely<Database>,
	images: string[],
	requestedBy: string | null,
): Promise<JobRow> {
	return db
		.insertInto("docker_seed_jobs")
		.values({ images: JSON.stringify(images), requested_by: requestedBy })
		.returning([
			"id",
			"state",
			"step",
			"images",
			"message",
			"requested_at",
			"finished_at",
		])
		.executeTakeFirstOrThrow();
}
