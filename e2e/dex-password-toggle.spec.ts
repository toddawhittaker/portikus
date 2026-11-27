import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoViolations } from "./helpers";

// The show-or-hide button in the Dex password field (SPEC.md
// section 25.8; ADR 0023, "Pages"). The e2e stack signs in through a mock
// provider, not Dex, so this page is Dex's password row as the pinned
// template renders it after web.yml's patches, with the theme's real
// stylesheet and script. web.yml's guard proves the script tag lands in the
// real template; the CI Dex job serves it.
const THEME = fileURLToPath(
	new URL("../infra/ansible/roles/dex/files/theme/", import.meta.url),
);
const STYLES = readFileSync(`${THEME}styles.css`, "utf8");
const SCRIPT = readFileSync(`${THEME}password-toggle.js`, "utf8");

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>Sign in, Portikus</title><style>${STYLES}</style></head>
<body class="theme-body"><div class="dex-container" role="main"><div class="theme-panel">
  <h1 class="theme-heading">Sign in to Portikus</h1>
  <form method="post" action="/submitted">
    <div class="theme-form-row">
      <div class="theme-form-label"><label for="login">Email Address</label></div>
      <input required id="login" name="login" type="text" autocomplete="username" class="theme-form-input" placeholder="email address" autofocus />
    </div>
    <div class="theme-form-row">
      <div class="theme-form-label"><label for="password">Password</label></div>
      <input required id="password" name="password" type="password" autocomplete="current-password" class="theme-form-input" placeholder="password" />
    </div>
    <button id="submit-login" type="submit" class="dex-btn theme-btn--primary">Sign in</button>
  </form>
</div></div>
<script>${SCRIPT}</script>
</body></html>`;

async function open(page: import("@playwright/test").Page) {
	let submitted = false;
	await page.route("**/submitted", (route) => {
		submitted = true;
		return route.fulfill({ body: "sent" });
	});
	await page.route("http://dex.test/", (route) =>
		route.fulfill({ contentType: "text/html", body: PAGE }),
	);
	await page.goto("http://dex.test/");
	return { wasSubmitted: () => submitted };
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`the password field has a show-or-hide button (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 820, height: 1180 }); // an iPad
		const form = await open(page);
		const field = page.getByLabel("Password", { exact: true });
		const show = page.getByRole("button", { name: "Show password" });

		// Starts hidden, with the button inside the right end of the field.
		await expect(field).toHaveAttribute("type", "password");
		await expect(show).toBeVisible();
		const fieldBox = await field.boundingBox();
		const buttonBox = await show.boundingBox();
		if (!fieldBox || !buttonBox) throw new Error("no layout");
		expect(buttonBox.width).toBeGreaterThanOrEqual(44);
		expect(buttonBox.height).toBeGreaterThanOrEqual(44);
		expect(buttonBox.x + buttonBox.width).toBeCloseTo(fieldBox.x + fieldBox.width, 0);
		expect(buttonBox.y + buttonBox.height / 2).toBeCloseTo(
			fieldBox.y + fieldBox.height / 2,
			0,
		);
		await expect(page.locator(".theme-password-eye")).toBeVisible();
		await expect(page.locator(".theme-password-eye-off")).toBeHidden();
		await expectNoViolations(page);
		// The icon has contrast against the field.
		expect(await show.evaluate((el) => getComputedStyle(el).color)).not.toBe(
			await field.evaluate((el) => getComputedStyle(el).backgroundColor),
		);

		// A click shows the password and keeps the value and the cursor.
		await field.fill("secret-pass");
		await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
		await show.click();
		await expect(field).toHaveAttribute("type", "text");
		await expect(field).toHaveValue("secret-pass");
		await expect(field).toBeFocused();
		expect(
			await field.evaluate((el: HTMLInputElement) => [
				el.selectionStart,
				el.selectionEnd,
			]),
		).toEqual([3, 3]);
		await expect(page.locator(".theme-password-eye-off")).toBeVisible();
		await expect(page.locator(".theme-password-eye")).toBeHidden();
		await expectNoViolations(page);

		// A second click hides it again; neither click sent the form.
		await page.getByRole("button", { name: "Hide password" }).click();
		await expect(field).toHaveAttribute("type", "password");
		await expect(field).toHaveValue("secret-pass");
		expect(form.wasSubmitted()).toBe(false);
		await expect(page).toHaveURL("http://dex.test/");
	});
}

test("the show-or-hide button works from the keyboard and never sends the form", async ({
	page,
}) => {
	const form = await open(page);
	const field = page.getByLabel("Password", { exact: true });
	await field.fill("secret-pass");
	await field.press("Tab");
	const show = page.getByRole("button", { name: "Show password" });
	await expect(show).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(field).toHaveAttribute("type", "text");
	await page.keyboard.press("Space");
	await expect(field).toHaveAttribute("type", "password");
	await expect(page.getByRole("button", { name: "Show password" })).toBeFocused();
	expect(form.wasSubmitted()).toBe(false);

	// Shown, then sent: the field is a password field again when it goes.
	await page.keyboard.press("Enter");
	await expect(field).toHaveAttribute("type", "text");
	await page.getByLabel("Email Address").fill("alice@example.edu");
	await page.evaluate(() => {
		const input = document.getElementById("password") as HTMLInputElement;
		input.form?.addEventListener("submit", () => {
			(window as unknown as { sentAs: string }).sentAs = input.type;
		});
	});
	const sentAs = page.waitForFunction(
		() => (window as unknown as { sentAs?: string }).sentAs,
	);
	await page.getByRole("button", { name: "Sign in" }).click();
	expect(await (await sentAs).jsonValue()).toBe("password");
	await expect(page).toHaveURL("http://dex.test/submitted");
	expect(form.wasSubmitted()).toBe(true);
});

test("the password starts hidden on every load", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "Show password" }).click();
	await page.reload();
	await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
		"type",
		"password",
	);
	await expect(page.getByRole("button", { name: "Show password" })).toBeVisible();
});
