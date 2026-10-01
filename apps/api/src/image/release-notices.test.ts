/**
 * Release notices (SPEC.md section 22.4): every enabled
 * administrator hears once about a published image newer than every image
 * on the server, and once about a newer portikus package.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedReleasesFile } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { imagesDirOf, noticeReleases, readPublished } from "./release-notices.js";

const skip = !hasTestDb();
let tdb: TestDb;
let imagesDir: string;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	imagesDir = await mkdtemp(join(tmpdir(), "portikus-release-"));
	await mkdir(join(imagesDir, "2026.09.12"));
	if (!skip) await tdb.truncate();
	return () => rm(imagesDir, { recursive: true, force: true });
});

async function putPublished(file: Partial<PublishedReleasesFile>): Promise<void> {
	await writeFile(
		join(imagesDir, "published.json"),
		JSON.stringify({
			checkedAt: "2026-09-29T04:00:00.000Z",
			image: null,
			package: null,
			...file,
		}),
	);
}

async function titlesFor(userId: string): Promise<string[]> {
	const rows = await tdb.db
		.selectFrom("notifications")
		.select("title")
		.where("user_id", "=", userId)
		.orderBy("title")
		.execute();
	return rows.map((row) => row.title);
}

test("the image store sits beside the job directory", () => {
	expect(imagesDirOf("/var/lib/portikus/image-jobs")).toBe("/var/lib/portikus/images");
});

test("readPublished is null when the check never ran or wrote nonsense", async () => {
	expect(await readPublished(imagesDir)).toBeNull();
	await writeFile(join(imagesDir, "published.json"), '{"image": "../x"}');
	expect(await readPublished(imagesDir)).toBeNull();
});

test.skipIf(skip)(
	"notifies each enabled administrator once per version, and no one else",
	async () => {
		const admin = await insertTestUser(tdb.db, { role: "administrator" });
		const disabled = await insertTestUser(tdb.db, {
			role: "administrator",
			disabled_at: new Date().toISOString(),
		});
		const student = await insertTestUser(tdb.db);
		await putPublished({
			image: "2026.09.13",
			package: { installed: "0.1.695", available: "0.1.700" },
		});

		await noticeReleases(tdb.db, imagesDir);
		await noticeReleases(tdb.db, imagesDir);

		expect(await titlesFor(admin)).toEqual([
			"Portikus 0.1.700 is available",
			"Workspace image 2026.09.13 is published",
		]);
		expect(await titlesFor(disabled)).toEqual([]);
		expect(await titlesFor(student)).toEqual([]);
	},
);

test.skipIf(skip)("a later version gets its own notification", async () => {
	const admin = await insertTestUser(tdb.db, { role: "administrator" });
	await putPublished({ image: "2026.09.13" });
	await noticeReleases(tdb.db, imagesDir);
	await putPublished({ image: "2026.09.14" });
	await noticeReleases(tdb.db, imagesDir);
	expect(await titlesFor(admin)).toEqual([
		"Workspace image 2026.09.13 is published",
		"Workspace image 2026.09.14 is published",
	]);
});

test.skipIf(skip)("stays quiet when the newest image is on the server", async () => {
	const admin = await insertTestUser(tdb.db, { role: "administrator" });
	await putPublished({ image: "2026.09.12" });
	await noticeReleases(tdb.db, imagesDir);
	expect(await titlesFor(admin)).toEqual([]);
});

test.skipIf(skip)("two checks at once still send one notification", async () => {
	const admin = await insertTestUser(tdb.db, { role: "administrator" });
	await putPublished({ image: "2026.09.13" });
	await Promise.all([
		noticeReleases(tdb.db, imagesDir),
		noticeReleases(tdb.db, imagesDir),
	]);
	expect(await titlesFor(admin)).toEqual(["Workspace image 2026.09.13 is published"]);
});
