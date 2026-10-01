import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ImageVersion,
	newerPublishedImage,
	PublishedReleasesFile,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";

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
export async function versionsOnServer(imagesDir: string): Promise<ImageVersion[]> {
	let names: string[];
	try {
		names = await readdir(imagesDir);
	} catch {
		return [];
	}
	return names.filter((name) => ImageVersion.safeParse(name).success);
}

export interface Notice {
	action: string;
	target: string;
	title: string;
	body: string;
	/** Defaults to "release-check" and "neutral". */
	actor?: string;
	tone?: "neutral" | "warning" | "danger";
}

/**
 * One neutral notification per enabled administrator, the first time this
 * action and target are seen. The audit row is the record that it was sent.
 */
export async function notifyOnce(
	db: Kysely<Database>,
	notice: Notice,
): Promise<boolean> {
	return db.transaction().execute(async (trx) => {
		// The hourly timer and a page load can race; this makes the check and insert one step.
		await sql`select pg_advisory_xact_lock(hashtext('portikus.release-notice'))`.execute(
			trx,
		);
		const seen = await trx
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", notice.action)
			.where("target", "=", notice.target)
			.executeTakeFirst();
		if (seen) return false;
		await recordAudit(trx, {
			actor: notice.actor ?? "release-check",
			target: notice.target,
			action: notice.action,
			result: "ok",
			metadata: {},
		});
		const admins = await trx
			.selectFrom("users")
			.select("id")
			.where("role", "=", "administrator")
			.where("disabled_at", "is", null)
			.execute();
		if (admins.length > 0) {
			await trx
				.insertInto("notifications")
				.values(
					admins.map((admin) => ({
						user_id: admin.id,
						tone: notice.tone ?? "neutral",
						title: notice.title,
						body: notice.body,
					})),
				)
				.execute();
		}
		return true;
	});
}

/**
 * Tell administrators once about a published image newer than every image
 * on the server, and once about a newer portikus package (issue #861).
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
