import { type Browser, expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, openToggletip, query, WEB_ORIGIN } from "./helpers";

/**
 * The Logs tab (SPEC.md section 24.11). The e2e API's
 * standard output is the fake journalctl's journal, so a warning the API
 * really logs shows up here. Each test makes its own student, so it can
 * filter to lines no other test wrote. The API runs at most two journalctl
 * processes at once, so these tests run one after another.
 */
test.describe.configure({ mode: "serial" });

/** The API's per-user limit on recorded notifications (apps/api/src/routes/notifications.ts). */
const NOTIFICATION_RECORDS_PER_MINUTE = 30;

interface Warned {
	userId: string;
	workspaceId: string;
	name: string;
}

/**
 * A student who records notifications past the per-minute limit, whose 429
 * the API logs as a warning. The student also hits the 20-terminal limit,
 * a refusal logged at info with the workspace on it, and reads the
 * workspace, also at info.
 */
async function causeWarning(browser: Browser): Promise<Warned> {
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
		for (let i = 0; i < NOTIFICATION_RECORDS_PER_MINUTE; i++) {
			const recorded = await context.request.post("/me/notifications", {
				headers: { origin: WEB_ORIGIN },
				data: { tone: "neutral", title: "e2e" },
			});
			expect(recorded.status()).toBe(201);
		}
		const limited = await context.request.post("/me/notifications", {
			headers: { origin: WEB_ORIGIN },
			data: { tone: "neutral", title: "e2e" },
		});
		expect(limited.status()).toBe(429);
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
		const warned = await causeWarning(browser);
		await loginAs(page, "carol");
		await openUntil(page, "/admin/logs", "RATE_LIMITED");

		// The person is chosen by name; the URL and the request carry the ID.
		await page.getByRole("combobox", { name: "Person" }).fill(warned.name);
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(new RegExp(`user=${warned.userId}`));
		await expect(logRows(page)).toHaveCount(1);
		const row = logRows(page).first();
		await expect(row.getByTestId("log-level")).toHaveText("Warn");
		await expect(row).toContainText("RATE_LIMITED");
		await expect(row).toContainText(warned.name);
		await expect(row).toContainText("429");

		// The full line opens under the row, redacted JSON as text.
		const toggle = row.getByRole("button", { name: /^Full line/ });
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("log-row-detail")).toContainText(
			`"userId": "${warned.userId}"`,
		);

		// Error only: the warning goes.
		await page.getByRole("checkbox", { name: "Warn" }).uncheck();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(/level=error(&|$)/);
		// Said once, with what to widen, and no empty table or "0 lines".
		await expect(page.getByTestId("logs-empty")).toHaveText(
			"No lines in the last day at Error match the other filters. Try a longer time, or include Warn.",
		);
		await expect(page.getByTestId("logs-table")).toHaveCount(0);
		await expect(page.getByTestId("logs-count")).toHaveText("");
	});

	test("Info and Debug switch on and off", async ({ page, browser }) => {
		const warned = await causeWarning(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin/logs?user=${warned.userId}`, "RATE_LIMITED");
		// The note on what each level needs is a toggletip beside Levels.
		await page.getByRole("button", { name: "About Levels" }).click();
		await expect(openToggletip(page)).toContainText(
			"Debug lines exist only while the service log level is Debug.",
		);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "About Levels" })).toBeFocused();
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

	test("View logs opens from a workspace detail panel and from its Account section", async ({
		page,
		browser,
	}) => {
		const warned = await causeWarning(browser);
		await loginAs(page, "carol");
		// Wait for the line to reach the journal before following the links.
		await openUntil(page, `/admin/logs?user=${warned.userId}`, "RATE_LIMITED");

		// The Users table keeps its seven columns; the user's logs link is in the panel.
		await page.goto("/admin");
		await page.getByTestId("admin-filter-text").fill(warned.name);
		await page.getByRole("button", { name: `Show details for ${warned.name}` }).click();
		const account = page.getByRole("region", { name: warned.name });
		const userLogs = account.getByRole("link", { name: "View this user's logs" });
		// pk-link is styled: underlined in the accent text colour.
		await expect(userLogs).toHaveCSS("text-decoration-line", "underline");
		await userLogs.focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(new RegExp(`/admin/logs\\?.*user=${warned.userId}`));
		await expect(page.getByRole("combobox", { name: "Person" })).toHaveValue(
			warned.name,
		);
		await expect(logRows(page).first()).toContainText("RATE_LIMITED");
		// Focus lands on the Logs heading, not the top of the page.
		await expect(page.getByRole("heading", { level: 2, name: "Logs" })).toBeFocused();

		await page.goto("/admin");
		await page.getByTestId("admin-filter-text").fill(warned.name);
		await page.getByRole("button", { name: `Show details for ${warned.name}` }).click();
		const panel = page.getByRole("region", { name: warned.name });
		await expect(panel.getByText(/journalctl/)).toHaveCount(0);
		// The workspace's logs link sits in the panel's Recent audit section.
		await panel
			.getByRole("region", { name: "Recent audit events" })
			.getByRole("link", { name: "Logs for this workspace" })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`/admin/logs\\?.*workspace=${warned.workspaceId}.*since=1h`),
		);
		const only = page.getByRole("checkbox", {
			name: `Only ${warned.name}'s workspace`,
		});
		await expect(only).toBeChecked();
		// The workspace's own line, the terminal limit, is a refusal logged at info.
		await page.getByRole("checkbox", { name: "Info" }).check();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).toHaveURL(new RegExp(`workspace=${warned.workspaceId}`));
		await expect(
			logRows(page).filter({ hasText: "TERMINAL_LIMIT" }).first(),
		).toBeVisible();
		// Unticked and applied, the workspace filter leaves the URL.
		await only.uncheck();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page).not.toHaveURL(/workspace=/);
		await expect(only).toHaveCount(0);
	});

	test("a bar of the errors chart on Health opens a filtered Logs tab", async ({
		page,
		browser,
	}) => {
		const warned = await causeWarning(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin/logs?user=${warned.userId}`, "RATE_LIMITED");
		await page.evaluate(() => localStorage.setItem("portikus.admin.healthRange", "1h"));

		await expect(async () => {
			await page.goto("/admin/health");
			await expect(
				page.getByTestId("health-chart-logs").locator('rect[data-series="1"]').first(),
			).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
		await expect(page.getByTestId("health-chart-logs-summary")).toContainText(
			"warning",
		);

		// A click anywhere in the warning segment's column, through the hit area.
		const warningBar = page
			.getByTestId("health-chart-logs")
			.locator('rect[data-series="1"]')
			.last();
		await warningBar.scrollIntoViewIfNeeded();
		const bar = await warningBar.boundingBox();
		if (!bar) throw new Error("the warning bar has no box");
		await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
		await expect(page).toHaveURL(/\/admin\/logs\?.*level=warn.*since=.*until=/);
		await expect(page.getByRole("checkbox", { name: "Warn" })).toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Error" })).not.toBeChecked();
		await expect(logRows(page).first()).toBeVisible();
	});

	test("the whole flow works from the keyboard alone", async ({ page, browser }) => {
		const warned = await causeWarning(browser);
		await loginAs(page, "carol");
		await openUntil(page, `/admin/logs?user=${warned.userId}`, "RATE_LIMITED");

		// Health: the errors chart's bar opens Logs with Enter.
		await page.evaluate(() => localStorage.setItem("portikus.admin.healthRange", "1h"));
		await page.goto("/admin/health");
		const plot = page.getByTestId("health-chart-logs-plot");
		await plot.focus();
		await page.keyboard.press("End");
		await expect(page.getByTestId("health-chart-logs-readout")).toContainText("Errors");
		await page.keyboard.press("ArrowUp");
		await expect(page.getByTestId("health-chart-logs-readout")).toContainText(
			"(selected)",
		);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/admin\/logs\?.*level=warn/);
		await expect(page.getByRole("heading", { level: 2, name: "Logs" })).toBeFocused();

		// Logs: a filter typed and applied with Enter, a checkbox with Space.
		await page.getByRole("checkbox", { name: "Error" }).focus();
		await page.keyboard.press("Space");
		await expect(page.getByRole("checkbox", { name: "Error" })).toBeChecked();
		// Time is a native select (the chart link set a custom range): Home picks Last hour.
		await page.getByRole("combobox", { name: "Time" }).focus();
		await page.keyboard.press("Home");
		await expect(page.getByRole("combobox", { name: "Time" })).toHaveValue("1h");
		await page.getByRole("combobox", { name: "Person" }).focus();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.type(warned.name);
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
		await expect(page.getByTestId("log-row-detail")).toContainText("RATE_LIMITED");
		await page.keyboard.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
	});

	test("the service log level sits above the filters, which are one grouped block", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/logs");
		const level = page.getByRole("combobox", { name: "Services log at" });
		// No value check: admin.spec.ts changes this site-wide setting in a
		// parallel worker, and this test is about layout.
		await expect(level).toBeEnabled({ timeout: 15_000 });
		const filters = page.getByRole("group", { name: "Filters" });
		const levelBox = await level.boundingBox();
		const filtersBox = await filters.boundingBox();
		if (!levelBox || !filtersBox) throw new Error("not visible");
		expect(levelBox.y + levelBox.height).toBeLessThanOrEqual(filtersBox.y);
		// On the sunken surface, with Apply and Clear inside it.
		await expect(filters).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(filters.getByRole("button", { name: "Apply filters" })).toBeVisible();
		await expect(filters.getByRole("button", { name: "Clear" })).toBeVisible();
		await expect(page.getByLabel("User ID")).toHaveCount(0);
		await expect(page.getByLabel("Workspace ID")).toHaveCount(0);

		// A name nobody has is refused in the form, and nothing is sent.
		const person = page.getByRole("combobox", { name: "Person" });
		await person.fill("Nobody By This Name");
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(person).toHaveAttribute("aria-invalid", "true");
		await expect(person).toHaveAccessibleDescription("Choose a person from the list.");
		await expect(page).not.toHaveURL(/user=/);
	});

	test("Load older lines pages back within the time window", async ({
		page,
		browser,
	}) => {
		// More than one page (100 lines) of one student's info lines.
		const context = await browser.newContext({ baseURL: WEB_ORIGIN });
		let userId: string;
		try {
			const student = await createStudent(context);
			userId = student.userId;
			for (let i = 0; i < 110; i++) {
				const read = await context.request.get(`/workspaces/${student.workspaceId}`);
				expect(read.status()).toBe(200);
			}
		} finally {
			await context.close();
		}
		await loginAs(page, "carol");
		await expect(async () => {
			await page.goto(`/admin/logs?level=info&since=1h&user=${userId}`);
			await expect(logRows(page)).toHaveCount(100, { timeout: 2_000 });
			await expect(page.getByTestId("logs-older")).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });

		await page.getByTestId("logs-older").click();
		await expect(page.getByTestId("logs-error")).toHaveCount(0);
		await expect.poll(() => logRows(page).count()).toBeGreaterThan(100);
		await expect(page.getByTestId("logs-error")).toHaveCount(0);
	});
});
