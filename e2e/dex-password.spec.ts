import { expect, type Page, test } from "@playwright/test";
import { FAKE_DEX_RIGHT_PASSWORD } from "./helpers";

/**
 * Dex's password form, relayed by the API (SPEC.md section 24.13). The form
 * page itself is Dex's; a stand-in is served here, and its post goes through
 * the real API to a fake Dex (e2e/fake-dex-login.mjs).
 */

const FORM_PATH = "/dex/auth/local/login?back=&state=e2e";

async function openForm(page: Page): Promise<void> {
	await page.route("**/dex/auth/local/login*", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html lang="en"><title>Sign in</title><main>
				<form method="post" action="${FORM_PATH}">
					<label>Email <input name="login"></label>
					<label>Password <input name="password" type="password"></label>
					<button type="submit">Sign in</button>
				</form></main></html>`,
		});
	});
	await page.goto(FORM_PATH);
}

async function submit(page: Page, login: string, password: string): Promise<void> {
	await page.getByLabel("Email").fill(login);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
}

test("a wrong password shows Dex's error", async ({ page }) => {
	await openForm(page);
	await submit(
		page,
		`wrong-${test.info().workerIndex}@example.edu`,
		"not-the-password-at-all",
	);
	await expect(page.getByRole("alert")).toHaveText(
		"Invalid Email Address and password.",
	);
});

test("the relayed wrong-password page keeps its styles, logo and script", async ({
	page,
}) => {
	const blocked: string[] = [];
	page.on("console", (message) => {
		if (/content security policy/i.test(message.text())) blocked.push(message.text());
	});
	await page.route("**/dex/theme/styles.css", (route) =>
		route.fulfill({ contentType: "text/css", body: "main { color: rgb(1, 2, 3); }" }),
	);
	await page.route("**/dex/theme/logo.svg", (route) =>
		route.fulfill({
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
		}),
	);
	await openForm(page);
	await submit(page, `styled-${test.info().workerIndex}@example.edu`, "not-it-at-all");
	await expect(page.getByRole("alert")).toHaveText(
		"Invalid Email Address and password.",
	);
	await expect(page.locator("main")).toHaveCSS("color", "rgb(1, 2, 3)");
	await expect(page.locator("html")).toHaveAttribute("data-scripted", "yes");
	expect(
		await page
			.getByRole("img", { name: "Portikus" })
			.evaluate((img) => (img as HTMLImageElement).naturalWidth),
	).toBeGreaterThan(0);
	expect(blocked).toEqual([]);
});

test("an account with too many wrong passwords gets a clear message", async ({
	page,
}) => {
	const login = `throttled-${test.info().workerIndex}-${Date.now()}@example.edu`;
	for (let i = 0; i < 10; i += 1) {
		await openForm(page);
		await submit(page, login, `wrong-password-number-${i}`);
		await expect(page.getByRole("alert")).toBeVisible();
	}
	await openForm(page);
	// Even the right password waits once the account is held.
	await submit(page, login, FAKE_DEX_RIGHT_PASSWORD);
	await expect(
		page.getByRole("heading", { name: "Too many sign-in attempts" }),
	).toBeVisible();
	await expect(page.getByText("Wait ten minutes, then try again.")).toBeVisible();
	await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
		"href",
		"/auth/login",
	);
});
