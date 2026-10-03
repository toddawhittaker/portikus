import { expect, type Locator, type Page, test } from "@playwright/test";
import { createStudent, query, WEB_ORIGIN, workspacePath } from "./helpers";
import { API_ORIGIN } from "./ports";

/**
 * The Profile section of Settings (SPEC.md §13.5): links are
 * checked, saved when the student leaves the field, and shown only as plain
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
	// A Dex subject is an opaque base64 blob.
	await query(
		"update users set oidc_subject = $1, preferred_username = $2 where id = $3",
		[`CiQ${student.userId}`, "e2e-name", student.userId],
	);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openProfile(page);
	const name = signInValue(dialog, "Sign-in name");
	await expect(name).toHaveText("e2e-name");
	// An ID, so it reads in the monospace face, as IDs do on the admin pages.
	expect(await name.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
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
	await expect(dialog.getByRole("button", { name: "Save links" })).toHaveCount(0);

	// The server refuses it too, whatever the browser does.
	const refused = await page.request.put("/me/profile", {
		data: { website: "http://example.edu/" },
		headers: { origin: new URL(page.url()).origin },
	});
	expect(refused.status()).toBe(400);

	await dialog.getByLabel("Personal site").fill("https://example.edu/~student");
	await dialog.getByLabel("GitHub").fill("e2e-student");
	// Leaving the field saves the valid links; the bad one was never sent.
	await dialog.getByLabel("GitHub").press("Tab");
	await expect(dialog.getByTestId("profile-website-link")).toBeVisible();
	await expect(dialog.getByTestId("profile-github-link")).toBeVisible();
	await expect(dialog.getByTestId("settings-saved")).toHaveText("Saved");
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

/** No silent loss: a link typed before Escape is saved. */
test("a link still being typed is saved when Escape closes Settings", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	let dialog = await openProfile(page);
	await dialog.getByLabel("GitHub").fill("typed-then-escape");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await expect
		.poll(
			async () =>
				(
					(await (await page.request.get("/me/profile")).json()) as {
						github: string | null;
					}
				).github,
		)
		.toBe("typed-then-escape");
	dialog = await openProfile(page);
	await expect(dialog.getByLabel("GitHub")).toHaveValue("typed-then-escape");
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
	// A button described by the hint opens the hidden file field's picker.
	const choose = dialog.getByRole("button", { name: "Choose picture…" });
	await expect(choose).toHaveAccessibleDescription(/A PNG or JPEG of up to 1 MiB/);
	const input = dialog.getByTestId("profile-picture-input");
	await expect(input).toBeHidden();
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
	await expect(choose).toHaveAccessibleDescription(
		/A PNG or JPEG of up to 1 MiB.*The picture must be at most 1 MiB/,
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

	// Removing it brings the initials back and keeps focus beside the picture.
	await dialog.getByRole("button", { name: "Remove picture" }).click();
	await expect(dialog.getByTestId("account-initials")).toBeVisible();
	await expect(page.getByTestId("account-picture")).toHaveCount(0);
	await expect(choose).toBeFocused();
});

test("group titles stand apart and a long email wraps inside the dialog", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const email = `a-very-long-address-that-would-run-out-of-the-dialog-${student.userId}@students.example.edu`;
	await query("update users set email = $1 where id = $2", [email, student.userId]);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openProfile(page);
	// Read-only values are text in a description list, not form fields.
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

	// Group titles use the heading style and field labels regular weight, so
	// the two never look alike. Groups are set apart by a rule and a full step
	// of space; the first group has no rule.
	const first = dialog.getByRole("region", {
		name: "From your institution sign-in",
	});
	const second = dialog.getByRole("heading", { name: "About you" });
	const label = dialog.locator("[data-testid=profile-signin] dt").first();
	const style = (el: Element) => ({
		weight: getComputedStyle(el).fontWeight,
		size: getComputedStyle(el).fontSize,
	});
	expect(await second.evaluate(style)).toEqual({ weight: "600", size: "15px" });
	expect(await label.evaluate(style)).toEqual({ weight: "400", size: "13px" });
	expect(await dialog.getByText("GitHub", { exact: true }).evaluate(style)).toEqual({
		weight: "400",
		size: "13px",
	});
	expect(
		await second.evaluate((el) => {
			const group = getComputedStyle(el.parentElement as Element);
			return [group.borderTopWidth, group.paddingTop];
		}),
	).toEqual(["1px", "24px"]);
	expect(await first.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
	await expect(dialog.getByText("All optional.")).toHaveCount(0);
});

test("the section heading is for screen readers, so the first group starts the pane", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	const dialog = await openProfile(page);

	const heading = dialog.getByRole("heading", {
		level: 2,
		name: "Profile",
		exact: true,
	});
	await expect(heading).toHaveCount(1);
	const size = await heading.evaluate((el) => {
		const box = el.getBoundingClientRect();
		return [box.width, box.height];
	});
	expect(size).toEqual([1, 1]);
	// The first group's heading sits at the top of the pane's padding.
	const gap = await dialog
		.getByRole("heading", { level: 3, name: "From your institution sign-in" })
		.evaluate((el) => {
			const section = el.closest("section[aria-labelledby=settings-section-profile]");
			const pane = section?.parentElement as Element;
			return (
				el.getBoundingClientRect().top -
				pane.getBoundingClientRect().top -
				Number.parseFloat(getComputedStyle(pane).paddingTop)
			);
		});
	expect(gap).toBeLessThan(1);
});

test("read-only sign-in details sit as label and value pairs on one line", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	const dialog = await openProfile(page);

	const rows = await dialog
		.locator("[data-testid=profile-signin] dt")
		.evaluateAll((terms) =>
			terms.map((term) => {
				const value = term.nextElementSibling as Element;
				const a = term.getBoundingClientRect();
				const b = value.getBoundingClientRect();
				return {
					left: Math.round(a.left),
					valueLeft: Math.round(b.left),
					sameRow: b.left >= a.right && b.top < a.bottom && b.bottom > a.top,
				};
			}),
		);
	expect(rows).toHaveLength(4);
	for (const row of rows) {
		expect(row.sameRow).toBe(true);
		// Every value starts in the same column.
		expect(row.valueLeft).toBe(rows[0]?.valueLeft);
		expect(row.left).toBe(rows[0]?.left);
	}
});
