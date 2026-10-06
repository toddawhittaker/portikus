import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs, routeApi } from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Notifications
 * section of the Settings tab, in both themes. The page data and the test
 * answer are served fixed, so these checks never write the settings file
 * that admin-notifications.spec.ts plays the root job on.
 */

const PAGE = {
	settings: {
		smtp: {
			host: "smtp.example.invalid",
			port: 465,
			username: "portikus",
			passwordSet: true,
			from: "Portikus <portikus@example.edu>",
		},
		alerts: {
			email: {
				to: ["ops@example.edu", "a-very-long-address-for-a-narrow-pane@example.edu"],
			},
			pushover: { userKeySet: true, appTokenSet: true },
			webhook: { host: "hooks.example.invalid", urlSet: true },
			ntfy: { host: "ntfy.example.invalid", urlSet: true, tokenSet: true },
			teams: null,
		},
		rootShellOpenedAlert: true,
	},
	job: {
		id: "33333333-3333-4333-8333-333333333333",
		state: "refused",
		code: "missing_secret",
		channels: [],
		hosts: [],
		requestedAt: "2026-10-06T10:00:00.000Z",
		startedAt: "2026-10-06T10:00:01.000Z",
		finishedAt: "2026-10-06T10:00:02.000Z",
	},
};

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Notifications section has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeApi(page, "**/admin/notifications", (route) =>
			route.fulfill({ json: PAGE }),
		);
		await routeApi(page, "**/admin/alerts/test", (route) =>
			route.fulfill({ json: { results: [{ channel: "webhook", ok: true }] } }),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/settings");
		const section = page.getByTestId("notify-section");
		await expect(section.getByLabel("Mail server")).toBeVisible({ timeout: 15_000 });

		// Every channel's fields, a refused job, a test result, a warning and an error.
		await section
			.getByRole("checkbox", { name: "Send alerts to Microsoft Teams" })
			.check();
		await section.getByRole("button", { name: "Send test to the webhook" }).click();
		await expect(section.getByTestId("notify-webhook-test-result")).toHaveText(
			"Sent. Check that it arrived.",
		);
		await section.getByLabel("Topic URL").fill("https://ntfy.other.invalid/alerts");
		await section.getByLabel("Topic URL").blur();
		await expect(
			section.getByTestId("notify-ntfy").getByText(/the stored token will be cleared/),
		).toBeVisible();
		// The first Save stops at the token warning; the second checks the form.
		await section.getByRole("button", { name: "Save notification settings" }).click();
		await expect(section.getByLabel("Access token")).toBeFocused();
		await section.getByRole("button", { name: "Save notification settings" }).click();
		await expect(section.getByLabel("Workflows webhook URL")).toBeFocused();
		await expect(section.getByTestId("notify-job")).toContainText("Not saved.");

		await expectNoViolations(page, '[data-testid="notify-section"]');
	});
}

/** The page with `job` as the latest job, and the test route answering `tested`. */
async function openWith(
	page: Page,
	job: Record<string, unknown>,
	tested: { status: number; json: unknown; headers?: Record<string, string> } = {
		status: 200,
		json: { results: [{ channel: "webhook", ok: true }] },
	},
) {
	await routeApi(page, "**/admin/notifications", (route) =>
		route.fulfill({ json: { ...PAGE, job: { ...PAGE.job, ...job } } }),
	);
	await routeApi(page, "**/admin/alerts/test", (route) => route.fulfill(tested));
	await page.goto("/admin/settings");
	const section = page.getByTestId("notify-section");
	await expect(section.getByLabel("Mail server")).toBeVisible({ timeout: 15_000 });
	return section;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a queued job, a stale job and a refused test have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		// A job waiting now: Save is unavailable and says why.
		const now = new Date().toISOString();
		let section = await openWith(page, {
			state: "queued",
			code: null,
			requestedAt: now,
			startedAt: null,
			finishedAt: null,
		});
		await expect(section.getByTestId("notify-job")).toContainText("Saving.");
		await expect(
			section.getByRole("button", { name: "Save notification settings" }),
		).toHaveAttribute("aria-disabled", "true");
		await expectNoViolations(page, '[data-testid="notify-section"]');

		// A job queued ten minutes ago: it did not finish.
		await page.unrouteAll({ behavior: "ignoreErrors" });
		section = await openWith(page, {
			state: "queued",
			code: null,
			requestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			startedAt: null,
			finishedAt: null,
		});
		await expect(section.getByTestId("notify-job")).toContainText(
			"The last change did not finish",
		);
		await expectNoViolations(page, '[data-testid="notify-section"]');

		// Too many tests in a minute.
		await page.unrouteAll({ behavior: "ignoreErrors" });
		section = await openWith(
			page,
			{},
			{
				status: 429,
				headers: { "retry-after": "42" },
				json: {
					code: "RATE_LIMITED",
					message: "Too many requests just now. Try again in a minute.",
				},
			},
		);
		await section.getByRole("button", { name: "Send test to the webhook" }).click();
		await expect(section.getByTestId("notify-webhook-test-result")).toHaveText(
			"Not sent: too many test alerts just now. Try again in a minute.",
		);
		await expectNoViolations(page, '[data-testid="notify-section"]');
	});
}
