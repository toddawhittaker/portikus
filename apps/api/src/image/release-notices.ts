import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ImageVersion,
	newerPublishedImage,
	PublishedReleasesFile,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { notifyOnce } from "../notifications/notify-once.js";

/** The image store sits beside the job directory: /var/lib/portikus/images. */
export function imagesDirOf(jobsDir: string): string {
	return join(dirname(jobsDir), "images");
}

/** `images/published.json` from `image-job check`; null when missing or malformed. */
export async function readPublished(
	imagesDir: string,
): Promise<PublishedReleasesFile | null> {
	try {
		const parsed = PublishedReleasesFile.safeParse(
			JSON.parse(await readFile(join(imagesDir, "published.json"), "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Every image version with a directory in the store. */
async function versionsOnServer(imagesDir: string): Promise<ImageVersion[]> {
	let names: string[];
	try {
		names = await readdir(imagesDir);
	} catch {
		return [];
	}
	return names.filter((name) => ImageVersion.safeParse(name).success);
}

/**
 * Tell administrators once about a published image newer than every image
 * on the server, and once about a newer portikus package.
 */
export async function noticeReleases(
	db: Kysely<Database>,
	imagesDir: string,
): Promise<void> {
	const published = await readPublished(imagesDir);
	if (!published) return;
	const image = newerPublishedImage(published.image, await versionsOnServer(imagesDir));
	if (image) {
		await notifyOnce(db, {
			action: "image.release_noticed",
			target: image,
			title: `Workspace image ${image} is published`,
			body: "Open Admin, then Workspace image, and choose Update to the latest published image.",
		});
	}
	if (published.package) {
		const { installed, available } = published.package;
		await notifyOnce(db, {
			action: "package.release_noticed",
			target: available,
			title: `Portikus ${available} is available`,
			body: `This server runs ${installed}. Run sudo apt update && sudo apt upgrade on the server to install it.`,
		});
	}
}

/** Check now and every interval (an hour by default); errors are logged, never thrown. */
export function startReleaseNotices(options: {
	db: Kysely<Database>;
	logger: Logger;
	imagesDir: string;
	intervalSeconds: number;
}): () => void {
	const { db, logger, imagesDir, intervalSeconds } = options;
	const tick = async (): Promise<void> => {
		try {
			await noticeReleases(db, imagesDir);
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "release notice error");
		}
	};
	const timer = setInterval(() => void tick(), intervalSeconds * 1000);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
