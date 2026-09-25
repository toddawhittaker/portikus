import { execFileSync } from "node:child_process";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createStudent, query, WEB_ORIGIN, workspacePath } from "./helpers";

/**
 * The first administrator's setup code (docs/EPIC-14.md rulings 15 to 17):
 * the entry point Ansible runs prints a code, the first person to enter it
 * at /setup becomes an administrator, and the code works only once. Fresh
 * accounts stand in for alice, because admin.spec.ts checks at the same time
 * that alice has no Administration link. This is the only spec that issues
 * a code, since issuing one deletes any unused one.
 */

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

/** Run the setup-code command against this run's database; it prints only the code. */
function issueCode(): string {
	const out = execFileSync(
		process.execPath,
		["packages/auth/dist/setup-code-main.js"],
		{
			encoding: "utf8",
			env: { ...process.env, DATABASE_URL },
		},
	);
	return out.trim();
}

async function studentPage(browser: Browser) {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(context);
	const page = await context.newPage();
	return { context, page, ...student };
}

async function enterCode(page: Page, code: string): Promise<void> {
	await page.goto("/setup");
	await page.getByLabel("Setup code").fill(code);
	await page.getByRole("button", { name: "Become administrator" }).click();
}

test("the printed code makes its first claimer an administrator, once", async ({
	browser,
}) => {
	test.setTimeout(60_000);
	const code = issueCode();
	expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

	const first = await studentPage(browser);
	const second = await studentPage(browser);
	try {
		await enterCode(first.page, code);
		await expect(first.page.getByTestId("setup-done")).toHaveText(
			"You are now an administrator.",
		);
		// Focus moves to the result so a screen reader reads it (SPEC.md 25.8).
		await expect(first.page.getByTestId("setup-done")).toBeFocused();
		await first.page.goto(workspacePath(first.workspaceId));
		await first.page.getByTestId("me").click({ timeout: 15_000 });
		await expect(first.page.getByTestId("admin-link")).toBeVisible();

		await enterCode(second.page, code);
		await expect(second.page.getByRole("alert")).toHaveText("That code is not valid.");
		const [row] = await query<{ role: string }>(
			"select role from users where id = $1",
			[second.userId],
		);
		expect(row?.role).toBe("student");
	} finally {
		await first.context.close();
		await second.context.close();
	}
});
