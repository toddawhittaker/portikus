import { expect, type Locator, type Page, test } from "@playwright/test";
import { createStudent, query, WEB_ORIGIN, workspacePath } from "./helpers";
import { API_ORIGIN } from "./ports";

/**
 * The Profile section of Settings (issue #300, SPEC.md §13.5): links are
 * checked, saved with their own Save links button and shown only as plain
 * anchors, and a picture is capped by the server and replaces the initials
 * in the account menu button.
 */

/** A 1 by 1 transparent PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

async function openProfile(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Profile", exact: true }).click();
	await expect(dialog.getByLabel("GitHub")).toBeVisible();
	return dialog;
}

/** The read-only value shown beside a sign-in label (a dt and its dd). */
function signInValue(dialog: Locator, label: string): Locator {
	return dialog.locator(`[data-testid=profile-signin] dt:text-is("${label}") + dd`);
}

test("the sign-in name is the username, not the identity provider's subject", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// A Dex subject is an opaque base64 blob (Epic 12b).
	await query(
		"update users set oidc_subject = $1, preferred_username = $2 where id = $3",
		[`CiQ${student.userId}`, "e2e-name", student.userId],
	);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openProfile(page);
	await expect(signInValue(dialog, "Sign-in name")).toHaveText("e2e-name");
});

test("a profile link is saved and shown as a plain anchor; a bad one is refused", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	let dialog = await openProfile(page);
	await dialog.getByLabel("Personal site").fill("javascript:alert(1)");
	await expect(dialog.getByText("Give an https:// link")).toBeVisible();
	const save = dialog.getByRole("button", { name: "Save links" });
	await expect(save).toBeDisabled();

	// The server refuses it too, whatever the browser does.
	const refused = await page.request.put("/me/profile", {
		data: { website: "http://example.edu/" },
		headers: { origin: new URL(page.url()).origin },
	});
	expect(refused.status()).toBe(400);

	await dialog.getByLabel("Personal site").fill("https://example.edu/~student");
	await dialog.getByLabel("GitHub").fill("e2e-student");
	await save.click();
	await expect(dialog.getByTestId("profile-links-saved")).toHaveText("Links saved");
	await dialog.getByTestId("settings-close").click();
	await expect(dialog).toHaveCount(0);

	dialog = await openProfile(page);
	const github = dialog.getByTestId("profile-github-link");
	await expect(github).toHaveAttribute("href", "https://github.com/e2e-student");
	await expect(github).toHaveAttribute("rel", "noopener");
	const site = dialog.getByTestId("profile-website-link");
	await expect(site).toHaveAttribute("href", "https://example.edu/~student");
	await expect(site).toHaveAttribute("rel", "noopener");
});

test("a picture over the cap is refused, and a saved one shows in the account button", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("account-picture")).toHaveCount(0);

	const dialog = await openProfile(page);
	const choose = dialog.getByRole("button", { name: "Choose picture…" });
	// The native file input is hidden; the labelled button opens its picker (review S3).
	await expect(dialog.getByTestId("profile-picture-input")).toBeHidden();
	const [chooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		choose.click(),
	]);
	await chooser.setFiles({
		name: "big.png",
		mimeType: "image/png",
		buffer: Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 1)]),
	});
	await expect(dialog.getByTestId("profile-picture-error")).toHaveText(
		"The picture must be at most 1 MiB",
	);
	await expect(page.getByTestId("account-picture")).toHaveCount(0);

	// The API refuses it on its own too. Sent straight to the API, because the
	// development proxy cannot relay an answer to a body the server stopped
	// reading.
	const refused = await page.request.put(`${API_ORIGIN}/me/picture`, {
		headers: { origin: WEB_ORIGIN, "content-type": "image/png" },
		data: Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 1)]),
	});
	expect(refused.status()).toBe(413);
	expect((await refused.json()).code).toBe("FILE_TOO_LARGE");

	const [second] = await Promise.all([
		page.waitForEvent("filechooser"),
		choose.click(),
	]);
	await second.setFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
	await expect(dialog.getByTestId("profile-picture")).toBeVisible();
	await expect(page.getByTestId("account-picture")).toHaveAttribute(
		"src",
		/^\/me\/picture\?v=\d+$/,
	);

	// Removing it brings the initials back and keeps focus beside the picture.
	await dialog.getByRole("button", { name: "Remove picture" }).click();
	await expect(dialog.getByTestId("account-initials")).toBeVisible();
	await expect(page.getByTestId("account-picture")).toHaveCount(0);
	await expect(choose).toBeFocused();
});

test("group titles stand apart and a long email wraps inside the dialog (issue #609)", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const email = `a-very-long-address-that-would-run-out-of-the-dialog-${student.userId}@students.example.edu`;
	await query("update users set email = $1 where id = $2", [email, student.userId]);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openProfile(page);
	// Read-only values are text in a description list, not form fields (review S1).
	const field = signInValue(dialog, "Email");
	await expect(field).toHaveText(email);
	await expect(dialog.getByTestId("profile-signin").getByRole("textbox")).toHaveCount(
		0,
	);
	const fits = await field.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const pane = el.closest(".pk-dialog")?.getBoundingClientRect();
		return {
			wraps: box.height > 30,
			inside: pane !== undefined && box.right <= pane.right,
			noScroll: el.scrollWidth <= el.clientWidth,
		};
	});
	expect(fits).toEqual({ wraps: true, inside: true, noScroll: true });

	// Group titles are body-size semibold, set apart by a rule and a full step
	// of space; the first group has no rule (review S2).
	const first = dialog.getByRole("heading", { level: 3 }).first();
	const second = dialog.getByRole("heading", { name: "About you" });
	const label = dialog.locator("[data-testid=profile-signin] dt").first();
	const title = await second.evaluate((el) => ({
		weight: getComputedStyle(el).fontWeight,
		size: getComputedStyle(el).fontSize,
	}));
	expect(title).toEqual({ weight: "600", size: "14px" });
	expect(await label.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
	expect(
		await second.evaluate((el) => {
			const group = getComputedStyle(el.parentElement as Element);
			return [group.borderTopWidth, group.paddingTop];
		}),
	).toEqual(["1px", "24px"]);
	expect(
		await first.evaluate(
			(el) => getComputedStyle(el.parentElement as Element).borderTopWidth,
		),
	).toBe("0px");
});
