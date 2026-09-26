import { type Browser, expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, query, WEB_ORIGIN } from "./helpers";

/**
 * The Logs tab (docs/EPIC-19.md rulings 31 to 37, issue #476). The e2e API's
 * standard output is the fake journalctl's journal, so a warning the API
 * really logs shows up here. Each test makes its own student, so it can
 * filter to lines no other test wrote. The API runs at most two journalctl
 * processes at once, so these tests run one after another.
 */
test.describe.configure({ mode: "serial" });

interface Warned {
	userId: string;
	workspaceId: string;
	name: string;
}

/** A student who hits the 20-terminal limit, which the API logs as a warning. */
async function causeTerminalLimit(browser: Browser): Promise<Warned> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const student = await createStudent(context);
		const name = `Logs ${student.userId.slice(0, 8)}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		await query(
			`insert into terminals (workspace_id, name, cwd, position)
			 select $1, 'Terminal ' || n, '/home/student', n from generate_series(1, 20) as n`,
			[student.workspaceId],
		);
		const refused = await context.request.post(
			`/workspaces/${student.workspaceId}/terminals`,
			{ headers: { origin: WEB_ORIGIN }, data: {} },
		);
		expect(refused.status()).toBe(409);
		// A successful read by the same student, logged at info.
		const read = await context.request.get(`/workspaces/${student.workspaceId}`);
		expect(read.status()).toBe(200);
		return { userId: student.userId, workspaceId: student.workspaceId, name };
	} finally {
		await context.close();
	}
}

function logRows(page: Page) {
	return page.getByTestId("logs-table").locator("tbody tr[data-testid=log-row]");
}

/** Open a Logs URL, reloading until the journal has the line (tee may lag). */
async function openUntil(page: Page, url: string, text: string): Promise<void> {
	await expect(async () => {
		await page.goto(url);
		await expect(page.getByTestId("logs-table")).toContainText(text, {
			timeout: 2_000,
		});
	}).toPass({ timeout: 20_000 });
}

test.describe("admin logs", () => {
	test("a known warning is found, and user and level filters narrow it", async ({
		page,
		browser,
	}) => {
		const warned = await causeTerminalLimit(browser);
		await loginAs(page, "carol");
		await openUntil(page, "/admin?tab=logs", "TERMINAL_LIMIT");

		await page.getByLabel("User ID").fill(warned.userId);
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(new RegExp(`user=${warned.userId}`));
		await expect(logRows(page)).toHaveCount(1);
		const row = logRows(page).first();
		await expect(row.getByTestId("log-level")).toHaveText("Warn");
		await expect(row).toContainText("TERMINAL_LIMIT");
		await expect(row).toContainText(warned.name);
		await expect(row).toContainText("409");

		// The full line opens under the row, redacted JSON as text.
		const toggle = row.getByRole("button", { name: /^Full line/ });
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("log-row-detail")).toContainText(
			`"workspaceId": "${warned.workspaceId}"`,
		);

		// Error only: the warning goes.
		await page.getByRole("checkbox", { name: "Warn" }).uncheck();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(/level=error(&|$)/);
		await expect(page.getByTestId("logs-empty")).toBeVisible();
	});

	test("Info and Debug switch on and off", async ({ page, browser }) => {
		const warned = await causeTerminalLimit(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin?tab=logs&user=${warned.userId}`, "TERMINAL_LIMIT");
		await expect(page.getByTestId("logs-level-note")).toContainText(
			"Debug lines exist only while the log level on the Settings tab is Debug.",
		);
		await expect(logRows(page)).toHaveCount(1);

		await page.getByRole("checkbox", { name: "Info" }).check();
		await page.getByRole("checkbox", { name: "Debug" }).check();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(
			/level=error%2Cwarn%2Cinfo%2Cdebug|level=error,warn,info,debug/,
		);
		await expect(
			page.getByTestId("log-level").filter({ hasText: "Info" }).first(),
		).toBeVisible();

		await page.getByRole("checkbox", { name: "Info" }).uncheck();
		await page.getByRole("checkbox", { name: "Debug" }).uncheck();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(logRows(page)).toHaveCount(1);
		await expect(page.getByTestId("log-level").filter({ hasText: "Info" })).toHaveCount(
			0,
		);
	});

	test("View logs opens from a workspace detail panel and from a user row", async ({
		page,
		browser,
	}) => {
		const warned = await causeTerminalLimit(browser);
		await loginAs(page, "carol");
		// Wait for the line to reach the journal before following the links.
		await openUntil(page, `/admin?tab=logs&user=${warned.userId}`, "TERMINAL_LIMIT");

		await page.goto("/admin");
		await page.getByTestId("admin-filter-text").fill(warned.name);
		await page.getByRole("link", { name: `View logs for ${warned.name}` }).click();
		await expect(page).toHaveURL(new RegExp(`tab=logs.*user=${warned.userId}`));
		await expect(page.getByLabel("User ID")).toHaveValue(warned.userId);
		await expect(logRows(page).first()).toContainText("TERMINAL_LIMIT");

		await page.goto("/admin");
		await page.getByTestId("admin-filter-text").fill(warned.name);
		await page.getByRole("button", { name: `Show details for ${warned.name}` }).click();
		const panel = page.getByRole("region", { name: warned.name });
		await expect(panel.getByText(/journalctl/)).toHaveCount(0);
		await panel.getByRole("link", { name: "View logs" }).click();
		await expect(page).toHaveURL(
			new RegExp(`tab=logs.*workspace=${warned.workspaceId}.*since=1h`),
		);
		await expect(page.getByLabel("Workspace ID")).toHaveValue(warned.workspaceId);
		await expect(logRows(page).first()).toContainText("TERMINAL_LIMIT");
	});

	test("a bar of the errors chart on Health opens a filtered Logs tab", async ({
		page,
		browser,
	}) => {
		const warned = await causeTerminalLimit(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin?tab=logs&user=${warned.userId}`, "TERMINAL_LIMIT");
		await page.evaluate(() => localStorage.setItem("portikus.admin.healthRange", "1h"));

		await expect(async () => {
			await page.goto("/admin?tab=health");
			await expect(
				page.getByTestId("health-chart-logs").locator('rect[data-series="1"]').first(),
			).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
		await expect(page.getByTestId("health-chart-logs-summary")).toContainText(
			"warning",
		);

		await page
			.getByTestId("health-chart-logs")
			.locator('rect[data-series="1"]')
			.last()
			.click();
		await expect(page).toHaveURL(/tab=logs.*level=warn.*since=.*until=/);
		await expect(page.getByRole("checkbox", { name: "Warn" })).toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Error" })).not.toBeChecked();
		await expect(logRows(page).first()).toBeVisible();
	});

	test("the whole flow works from the keyboard alone", async ({ page, browser }) => {
		const warned = await causeTerminalLimit(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin?tab=logs&user=${warned.userId}`, "TERMINAL_LIMIT");

		// Health: the errors chart's bar opens Logs with Enter.
		await page.evaluate(() => localStorage.setItem("portikus.admin.healthRange", "1h"));
		await page.goto("/admin?tab=health");
		const plot = page.getByTestId("health-chart-logs-plot");
		await plot.focus();
		await page.keyboard.press("End");
		await expect(page.getByTestId("health-chart-logs-readout")).toContainText("Errors");
		await page.keyboard.press("ArrowUp");
		await expect(page.getByTestId("health-chart-logs-readout")).toContainText(
			"(selected)",
		);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/tab=logs.*level=warn/);

		// Logs: a filter typed and applied with Enter, a checkbox with Space.
		await page.getByRole("checkbox", { name: "Error" }).focus();
		await page.keyboard.press("Space");
		await expect(page.getByRole("checkbox", { name: "Error" })).toBeChecked();
		await page.getByRole("combobox", { name: "Time" }).focus();
		await page.keyboard.press("Enter");
		await page.getByRole("option", { name: "Last hour" }).press("Enter");
		await page.getByLabel("User ID").focus();
		await page.keyboard.type(warned.userId);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(new RegExp(`since=1h.*user=${warned.userId}`));
		await expect(logRows(page)).toHaveCount(1);

		// The row's disclosure opens and closes with Enter.
		const toggle = logRows(page)
			.first()
			.getByRole("button", { name: /^Full line/ });
		await toggle.focus();
		await page.keyboard.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("log-row-detail")).toContainText("TERMINAL_LIMIT");
		await page.keyboard.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
	});
});
