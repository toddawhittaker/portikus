import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	loginAs,
	query,
	WEB_ORIGIN,
} from "./helpers";
import { launchAs, ltiUsers } from "./lti-helpers";

/**
 * An administrator links and unlinks a course account for someone else
 * (SPEC.md sections 5.2 and 20.1, ADR 0026). Kit exists in the mock LMS for
 * this spec alone.
 */

async function openDetail(page: Page, name: string) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	return page.getByRole("region", { name });
}

test("an administrator links a course account to an SSO account, then unlinks it, and the holder is told", async ({
	page,
	browser,
}) => {
	// A first-time launch creates the course account.
	const launchContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	await launchAs(await launchContext.newPage(), { person: "kit" });
	await launchContext.close();
	const [kit] = await ltiUsers("kit");
	const courseId = kit?.id ?? "";
	expect(courseId).not.toBe("");
	await query("delete from account_links where course_user_id = $1", [courseId]);
	await query("update workspaces set archived_at = null where owner_user_id = $1", [
		courseId,
	]);

	const name = `Link ${crypto.randomUUID().slice(0, 8)}`;
	const holderContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const student = await createStudent(holderContext);
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);

		const panel = await openDetail(page, name);
		await panel.getByRole("button", { name: "Link a course account…" }).click();
		const dialog = page.getByRole("dialog", {
			name: `Link a course account to ${name}`,
		});
		await dialog.getByLabel("Search course accounts").fill("Kit Joiner");
		await dialog.getByRole("radio", { name: /Kit Joiner/ }).check();
		await expectNoViolations(page, "[data-testid=link-dialog]");
		await dialog.getByRole("button", { name: "Continue" }).click();

		const confirm = page.getByRole("dialog", { name: "Link these accounts?" });
		await expect(confirm).toContainText("Kit Joiner");
		await expect(confirm).toContainText(`linked to ${name}`);
		await expectNoViolations(page, "[data-testid=link-dialog]");
		await confirm.getByRole("button", { name: "Link accounts" }).click();
		await expect(confirm).toBeHidden();

		const list = panel.getByTestId("detail-links");
		await expect(list).toContainText("Kit Joiner");
		const [linked] = await query<{ by: string }>(
			`select metadata->>'by' as by from audit_events
			 where action = 'user.linked' and target = $1`,
			[student.userId],
		);
		expect(linked?.by).toBe("administrator");

		await list.getByRole("button", { name: `Unlink Kit Joiner from ${name}` }).click();
		const unlink = page.getByRole("alertdialog", { name: "Unlink these accounts?" });
		await expect(unlink).toContainText("Kit Joiner");
		await expect(unlink).toContainText(name);
		await expectNoViolations(page, "[data-testid=unlink-dialog]");
		await unlink.getByRole("button", { name: "Unlink" }).click();
		await expect(unlink).toBeHidden();
		await expect(list).toContainText("No course accounts are linked.");

		// The holder is told of both changes.
		const holder = await holderContext.newPage();
		await holder.goto("/");
		await expect(holder.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
		await holder.getByTestId("me").click();
		await holder.getByRole("menuitem", { name: "Notifications" }).click();
		const notices = holder
			.getByTestId("dialog-notifications")
			.getByTestId("notification");
		await expect(
			notices.filter({ hasText: "linked a course account to yours" }),
		).toHaveCount(1);
		await expect(
			notices.filter({ hasText: "unlinked a course account from yours" }),
		).toHaveCount(1);
	} finally {
		await holderContext.close();
	}
});
