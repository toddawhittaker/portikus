import { expect, type Page, test } from "@playwright/test";
import { createStudent, query, WEB_ORIGIN, workspacePath } from "./helpers";
import { API_ORIGIN } from "./ports";

/**
 * The Profile section of Settings (issue #300, SPEC.md §13.5): links are
 * checked and shown only as plain anchors, and a picture is capped by the
 * server and replaces the initials in the account menu button.
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
	await expect(dialog.getByLabel("Sign-in name")).toHaveValue("e2e-name");
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
	await expect(page.getByTestId("editor-settings-save")).toBeDisabled();

	// The server refuses it too, whatever the browser does.
	const refused = await page.request.put("/me/profile", {
		data: { website: "http://example.edu/" },
		headers: { origin: new URL(page.url()).origin },
	});
	expect(refused.status()).toBe(400);

	await dialog.getByLabel("Personal site").fill("https://example.edu/~student");
	await dialog.getByLabel("GitHub").fill("e2e-student");
	await page.getByTestId("editor-settings-save").click();
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
	const input = dialog.getByTestId("profile-picture-input");
	await input.setInputFiles({
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

	await input.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
	await expect(dialog.getByTestId("profile-picture")).toBeVisible();
	await expect(page.getByTestId("account-picture")).toHaveAttribute(
		"src",
		/^\/me\/picture\?v=\d+$/,
	);
});
