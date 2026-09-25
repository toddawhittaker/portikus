/**
 * Automated accessibility checks (SPEC.md section 25.8) on the /setup page
 * (docs/EPIC-14.md, T2): the claim form with its error, the sign-in prompt,
 * and the first-account form a standalone Dex site shows.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createStudent } from "./helpers";

async function expectNoViolations(page: Page) {
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("the claim form and its error have no automatic violations", async ({
	context,
	page,
}) => {
	await createStudent(context);
	await page.goto("/setup");
	await expect(page.getByLabel("Setup code")).toBeVisible();
	await expectNoViolations(page);

	await page.getByLabel("Setup code").fill("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
	await page.getByRole("button", { name: "Become administrator" }).click();
	await expect(page.getByRole("alert")).toHaveText("That code is not valid.");
	await expectNoViolations(page);
});

test("the signed-out page and the first-account form have no automatic violations", async ({
	page,
}) => {
	// Whether an administrator exists depends on other specs, so each answer is faked.
	await page.route("**/setup/state", (route) =>
		route.fulfill({ json: { firstAccount: false } }),
	);
	await page.goto("/setup");
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
	await expectNoViolations(page);

	await page.unroute("**/setup/state");
	await page.route("**/setup/state", (route) =>
		route.fulfill({ json: { firstAccount: true } }),
	);
	await page.goto("/setup");
	await expect(page.getByLabel("Password again")).toBeVisible();
	await page.getByLabel("Password", { exact: true }).fill("short");
	await page.getByLabel("Password again").fill("other");
	await page.getByRole("button", { name: "Create administrator account" }).click();
	// Each error sits on its field, and focus goes to the first one.
	await expect(page.getByLabel("Email")).toBeFocused();
	await expect(page.getByLabel("Password again")).toHaveAccessibleDescription(
		"The two passwords do not match.",
	);
	await expectNoViolations(page);
});

test("both setup success messages take focus and have no automatic violations", async ({
	context,
	page,
}) => {
	// A real claim would use up the one printed code setup.spec.ts needs, so the posts are faked.
	await page.route("**/setup/claim", (route) => route.fulfill({ status: 204 }));
	await createStudent(context);
	await page.goto("/setup");
	await page.getByLabel("Setup code").fill("ABCD-EFGH-JKMN-PQRS");
	await page.getByRole("button", { name: "Become administrator" }).click();
	await expect(page.getByTestId("setup-done")).toBeFocused();
	await expectNoViolations(page);

	await context.clearCookies();
	await page.route("**/setup/state", (route) =>
		route.fulfill({ json: { firstAccount: true } }),
	);
	await page.route("**/setup/first-account", (route) => route.fulfill({ status: 204 }));
	await page.goto("/setup");
	await page.getByLabel("Email").fill("owner@example.edu");
	await page.getByLabel("Username").fill("owner");
	await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
	await page.getByLabel("Password again").fill("correct horse battery");
	await page.getByLabel("Setup code").fill("ABCD-EFGH-JKMN-PQRS");
	await page.getByRole("button", { name: "Create administrator account" }).click();
	await expect(page.getByTestId("setup-done")).toBeFocused();
	await expectNoViolations(page);
});

test("the setup forms have no automatic violations in the dark theme", async ({
	context,
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await createStudent(context);
	await page.goto("/setup");
	await expect(page.getByLabel("Setup code")).toBeVisible();
	await expectNoViolations(page);

	await context.clearCookies();
	await page.route("**/setup/state", (route) =>
		route.fulfill({ json: { firstAccount: true } }),
	);
	await page.goto("/setup");
	await page.getByRole("button", { name: "Create administrator account" }).click();
	await expect(page.getByLabel("Email")).toBeFocused();
	await expectNoViolations(page);
});
