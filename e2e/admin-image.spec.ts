import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, query, WEB_ORIGIN } from "./helpers";
import {
	IMAGE_JOBS_DIR,
	putImage,
	resetImageStore,
	setAliases,
	takeRequest,
	writeLog,
	writeStatus,
} from "./image-jobs";

/**
 * The Workspace image section (docs/EPIC-15.md rulings 22 to 28, flows 5
 * and 6; ADR 0030). The tests play the root job against a fake job directory:
 * they take each request file the API writes and answer with the status,
 * log, manifest and health the real job would write.
 */

// One job directory for the whole file, so the tests run in order.
test.describe.configure({ mode: "serial" });

const OLD = "2026.09.8";
const CURRENT = "2026.09.9";
const NEWEST = "2026.09.10";
const BROKEN = "2026.09.9-local.202609271200";

function fingerprint(): string {
	return crypto.randomUUID().replace(/-/g, "").repeat(2);
}

let fpCurrent: string;
let fpOld: string;

test.beforeEach(async () => {
	fpCurrent = fingerprint();
	fpOld = fingerprint();
	await resetImageStore();
	await putImage({ version: OLD, fingerprint: fpOld, health: "passed" });
	await putImage({ version: CURRENT, fingerprint: fpCurrent, health: "passed" });
	await setAliases(CURRENT, OLD);
});

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=image");
	await expect(
		page.getByRole("heading", { level: 2, name: "Workspace image", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("image-default")).toHaveText(CURRENT);
}

function confirmDialog(page: Page) {
	return page.getByTestId("image-confirm");
}

async function requestFiles(): Promise<string[]> {
	return (await readdir(IMAGE_JOBS_DIR)).filter((n) => n.startsWith("request-"));
}

test("update to the latest published image: progress, log, diff, then Make default", async ({
	page,
}) => {
	await open(page);
	await page.getByRole("button", { name: "Update to latest published" }).click();
	await confirmDialog(page).getByRole("button", { name: "Update" }).click();

	const { id, request } = await takeRequest();
	expect(request).toEqual({ kind: "fetch" });
	await writeStatus(id, "fetch", "running", "Downloading", null);
	await writeLog(id, ["fetching image-2026.09.10"]);

	const job = page.getByTestId("image-job");
	await expect(job.getByTestId("image-job-state")).toContainText("Downloading");
	await expect(job.getByTestId("image-job-log")).toContainText(
		"fetching image-2026.09.10",
	);
	// While it runs, nothing else can be asked for.
	await expect(
		page.getByRole("button", { name: "Rebuild with latest packages" }),
	).toHaveAttribute("aria-disabled", "true");

	// The page polls every two seconds: a new step and line arrive without a reload.
	await writeStatus(id, "fetch", "running", "Checking health", NEWEST);
	await writeLog(id, [
		"fetching image-2026.09.10",
		"signature good",
		"starting imgcheck-1",
	]);
	await expect(job.getByTestId("image-job-state")).toContainText("Checking health", {
		timeout: 5_000,
	});
	await expect(job.getByTestId("image-job-log")).toContainText("starting imgcheck-1");

	await putImage({
		version: NEWEST,
		fingerprint: fingerprint(),
		health: "passed",
		nodeVersion: "v24.9.0",
		packages: { curl: "8.14.1-3", git: "1:2.47.3-0", zsh: "5.9-8" },
	});
	await writeStatus(id, "fetch", "succeeded", "Done", NEWEST);

	const result = page.getByTestId("image-job-result");
	await expect(result).toBeVisible({ timeout: 5_000 });
	await expect(result.getByTestId("image-diff-tools")).toContainText(
		"v24.8.0 to v24.9.0",
	);
	await expect(result.getByTestId("image-diff-packages")).toContainText(
		"Added zsh 5.9-8",
	);
	await expect(result.getByTestId("image-diff-packages")).toContainText(
		"Changed curl: 8.14.1-2 to 8.14.1-3",
	);

	await result.getByRole("button", { name: `Make default: ${NEWEST}` }).click();
	await expect(confirmDialog(page)).toContainText(`Make ${NEWEST} the default image?`);
	await confirmDialog(page).getByRole("button", { name: "Make default" }).click();
	const activate = await takeRequest();
	expect(activate.request).toEqual({ kind: "activate", version: NEWEST });
	// The pressed button is gone, so focus lands on the job heading, not the page body.
	await expect(page.locator("#image-job-title")).toBeFocused();

	// The root job moves the aliases; the page follows.
	await setAliases(NEWEST, CURRENT);
	await writeStatus(activate.id, "activate", "succeeded", "Done", NEWEST);
	await expect(page.getByTestId("image-default")).toHaveText(NEWEST, {
		timeout: 5_000,
	});
	await expect(page.getByTestId("image-previous")).toHaveText(CURRENT);
});

test("the job log is polled every two seconds while the job runs", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "Update to latest published" }).click();
	await confirmDialog(page).getByRole("button", { name: "Update" }).click();
	const { id } = await takeRequest();
	await writeStatus(id, "fetch", "running", "Downloading", null);

	const times: number[] = [];
	page.on("request", (req) => {
		if (req.url().includes(`/admin/image/jobs/${id}`)) times.push(Date.now());
	});
	await expect.poll(() => times.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
	const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
	for (const gap of gaps) {
		expect(gap).toBeGreaterThan(1_500);
		expect(gap).toBeLessThan(3_500);
	}

	// Once it finishes, the polling stops.
	await writeStatus(
		id,
		"fetch",
		"failed",
		"Failed",
		null,
		"The signature did not verify.",
	);
	await expect(page.getByTestId("image-job-message")).toHaveText(
		"The signature did not verify.",
		{ timeout: 5_000 },
	);
	const settled = times.length;
	await page.waitForTimeout(4_500);
	expect(times.length).toBeLessThanOrEqual(settled + 1);
});

test("rebuild asks for Node and Python, then confirms", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "Rebuild with latest packages" }).click();
	const dialog = page.getByTestId("image-rebuild-dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Node").click();
	await page.getByRole("option", { name: "Node 26" }).click();
	await dialog.getByLabel("Python").click();
	await page.getByRole("option", { name: "Debian's plus Python 3.14 from uv" }).click();
	await dialog.getByRole("button", { name: "Rebuild" }).click();
	await expect(dialog).toHaveCount(0);

	const { id, request } = await takeRequest();
	expect(request).toEqual({ kind: "build", node: "26", python: "uv-3.14" });
	await writeStatus(id, "build", "running", "Building with distrobuilder", null);
	await expect(page.getByTestId("image-job-kind")).toHaveText(
		"Rebuild with latest packages: Node 26, Debian's plus Python 3.14 from uv",
		{ timeout: 5_000 },
	);
	await expect(page.getByTestId("image-job-state")).toContainText(
		"Building with distrobuilder",
	);
});

test("an image that failed its health check cannot be made default", async ({
	page,
}) => {
	await putImage({ version: BROKEN, fingerprint: fingerprint(), health: "failed" });
	await open(page);
	const row = page.getByTestId(`image-row-${BROKEN}`);
	await expect(row.getByTestId(`image-health-${BROKEN}`)).toHaveText("Failed");
	const make = row.getByRole("button", { name: `Make default: ${BROKEN}` });
	await expect(make).toHaveAttribute("aria-disabled", "true");
	await expect(make).toHaveAccessibleDescription("This image failed its health check.");
	// aria-disabled keeps it focusable; a forced click must still do nothing.
	await make.click({ force: true });
	await expect(confirmDialog(page)).toHaveCount(0);
	expect(await requestFiles()).toEqual([]);

	// Asking the API directly is refused too.
	const res = await page.request.post("/admin/image/jobs", {
		headers: { origin: WEB_ORIGIN },
		data: { kind: "activate", version: BROKEN },
	});
	expect(res.status()).toBe(409);
	expect((await res.json()).code).toBe("IMAGE_NOT_HEALTHY");
	expect(await requestFiles()).toEqual([]);
});

test("roll back swaps the default and the previous image", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "Roll back" }).click();
	await expect(confirmDialog(page)).toContainText(`Roll back to ${OLD}?`);
	await confirmDialog(page).getByRole("button", { name: "Roll back" }).click();
	const { id, request } = await takeRequest();
	expect(request).toEqual({ kind: "rollback" });
	await setAliases(OLD, CURRENT);
	await writeStatus(id, "rollback", "succeeded", "Done", OLD);
	await expect(page.getByTestId("image-default")).toHaveText(OLD, { timeout: 5_000 });
	await expect(page.getByTestId("image-previous")).toHaveText(CURRENT);
});

test("a request refused before its kind was known shows as refused", async ({
	page,
}) => {
	const id = crypto.randomUUID();
	await mkdir(join(IMAGE_JOBS_DIR, id), { recursive: true });
	await writeStatus(id, null, "refused", "Refused", null, "unknown kind");
	await open(page);
	const job = page.getByTestId("image-job");
	await expect(job.getByTestId("image-job-kind")).toHaveText("Unknown request");
	await expect(job.getByTestId("image-job-state")).toContainText("Refused");
	await expect(job.getByTestId("image-job-message")).toHaveText("unknown kind");
});

test("shows how many workspaces run each image version", async ({ page, browser }) => {
	const context = await browser.newContext();
	const a = await createStudent(context);
	const b = await createStudent(context);
	const c = await createStudent(context);
	await context.close();
	await query("update workspaces set image_version = $1 where id = any($2)", [
		fpCurrent,
		[a.workspaceId, b.workspaceId],
	]);
	await query("update workspaces set image_version = $1 where id = $2", [
		fpOld,
		c.workspaceId,
	]);
	await open(page);
	await expect(page.getByTestId(`image-workspaces-${CURRENT}`)).toHaveText("2");
	await expect(page.getByTestId(`image-workspaces-${OLD}`)).toHaveText("1");
	await expect(page.getByTestId("image-default-workspaces")).toHaveText("2");
});

test("a second request while one waits is refused", async ({ page }) => {
	await open(page);
	const first = await page.request.post("/admin/image/jobs", {
		headers: { origin: WEB_ORIGIN },
		data: { kind: "fetch" },
	});
	expect(first.status()).toBe(202);
	const second = await page.request.post("/admin/image/jobs", {
		headers: { origin: WEB_ORIGIN },
		data: { kind: "rollback" },
	});
	expect(second.status()).toBe(409);
	expect((await second.json()).code).toBe("IMAGE_JOB_BUSY");
	expect(await requestFiles()).toHaveLength(1);
	await page.reload();
	await expect(page.getByTestId("image-job-state")).toContainText("Waiting to start", {
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: "Roll back" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
});
