/**
 * A student's launch of a Deep Linking link lands on `/?starter=<id>` and
 * becomes a project (ADR 0058, SPEC.md §7.2). The picker and the API have
 * their own specs; this one covers what the student sees.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	FAKE_AGENT_TOKEN,
	projectDirs,
	query,
	readSeededFile,
	seedFile,
	seedProjectDir,
	settledAxe,
	toast,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";
import { launchAs, launchSavedLink, ltiUsers, startDeepLinking } from "./lti-helpers";

test.describe.configure({ mode: "serial" });

// Sam's workspace must be running, as the worker would make it, before a
// starter launch can create anything in it.
test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	await launchAs(page, { person: "sam" });
	await page.close();
	const workspaceId = await samWorkspaceId();
	await query(
		`update workspaces set state = 'running', desired_state = 'running',
		   agent_address = '127.0.0.1', agent_token = $2 where id = $1`,
		[workspaceId, `${FAKE_AGENT_TOKEN}:${workspaceId}`],
	);
});

const CREATED = "Your starter project is ready";
const OPENED = "Opened your existing project";
const EXPIRED = "This starter link has expired";

/** A lower-case name is its own folder name, so a test can seed that folder. */
function newName(): string {
	return `lab-${randomUUID().slice(0, 8)}`;
}

/** The instructor saves a template link under this name at the mock. */
async function saveLink(page: Page, name: string): Promise<void> {
	await startDeepLinking(page, { person: "ivy", course: "cs101" });
	await page.getByLabel("Template: Starter").check({ timeout: 30_000 });
	await page.getByLabel("Project name").fill(name);
	await page.getByRole("button", { name: "Add the link" }).click();
	await page.getByRole("button", { name: "Return to your course" }).click();
	await expect(page.getByRole("heading", { name: "Saved 1 link" })).toBeVisible();
}

async function samWorkspaceId(): Promise<string> {
	const [sam] = await ltiUsers("sam");
	const rows = await query<{ id: string }>(
		"select id from workspaces where owner_user_id = $1",
		[sam?.id],
	);
	const id = rows[0]?.id;
	if (!id) throw new Error("sam has no workspace yet");
	return id;
}

async function projectRows(name: string) {
	return query<{ id: string }>(
		"select p.id from projects p join workspaces w on w.id = p.workspace_id where p.slug = $1 and w.id = $2",
		[name, await samWorkspaceId()],
	);
}

test("the first launch creates the project and selects it", async ({ page }) => {
	const name = newName();
	await saveLink(page, name);
	await launchSavedLink(page, { title: name, person: "sam" });

	await expect(toast(page, CREATED)).toBeVisible({ timeout: 60_000 });
	const rows = await projectRows(name);
	expect(rows).toHaveLength(1);
	await expect(page).toHaveURL(
		new RegExp(`/workspaces/[0-9a-f-]+/projects/${rows[0]?.id}$`),
	);
	expect(page.url()).not.toContain("starter");
});

test("a second launch opens the same project", async ({ page }) => {
	const name = newName();
	await saveLink(page, name);
	await launchSavedLink(page, { title: name, person: "sam" });
	await expect(toast(page, CREATED)).toBeVisible({ timeout: 60_000 });

	await launchSavedLink(page, { title: name, person: "sam" });
	await expect(toast(page, OPENED)).toBeVisible({ timeout: 60_000 });
	const rows = await projectRows(name);
	expect(rows).toHaveLength(1);
	await expect(page).toHaveURL(new RegExp(`/projects/${rows[0]?.id}$`));
});

test("a folder that is already there is never overwritten", async ({ page }) => {
	const name = newName();
	const workspaceId = await samWorkspaceId();
	await seedProjectDir(workspaceId, name);
	await seedFile(workspaceId, name, "notes.txt", "my own work");
	await saveLink(page, name);
	await launchSavedLink(page, { title: name, person: "sam" });

	// The folder may already have been found as a project or not; either way
	// the launch opens or refuses it and creates nothing.
	await expect(page.locator(".pk-toast").first()).toBeVisible({ timeout: 60_000 });
	await expect(page.locator(".pk-toast").filter({ hasText: CREATED })).toHaveCount(0);
	expect(await readSeededFile(workspaceId, name, "notes.txt")).toBe("my own work");
	expect(await projectDirs(workspaceId)).toContain(name);
	expect(page.url()).not.toContain("starter");
});

test("an expired link says so, and the page has no axe violations", async ({
	page,
}) => {
	const name = newName();
	await saveLink(page, name);
	await launchSavedLink(page, { title: name, person: "sam" });
	await expect(toast(page, CREATED)).toBeVisible({ timeout: 60_000 });

	await page.goto(`${WEB_ORIGIN}/?starter=${randomUUID()}`);
	await expect(toast(page, EXPIRED)).toBeVisible({ timeout: 60_000 });
	expect(page.url()).not.toContain("starter");

	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
