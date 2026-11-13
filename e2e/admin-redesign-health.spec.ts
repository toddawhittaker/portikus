import { expect, type Page, test } from "@playwright/test";
import { loginAs, routeApi, studentIn } from "./helpers";

/**
 * The Health page's Needs attention list and the status bar at the foot of
 * every admin page (SPEC.md section 25.6). The whole report is answered in
 * the browser: these tests never write the health samples
 * admin-health.spec.ts owns, and never wait on the real report, which asks
 * every workspace agent other specs leave behind.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const GIB = 1024 ** 3;

const HOST = {
	loadAverage: [1.25, 0.9, 0.5],
	cpuCount: 4,
	memory: { usedBytes: 6 * GIB, totalBytes: 16 * GIB },
	pool: { usedBytes: 30 * GIB, totalBytes: 100 * GIB, metadataPercent: 10 },
	profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
	image: { fingerprint: "abcdef0123456789abcdef", serial: "2026.11.4" },
};

/** A calm report: a reachable host, no failures, nothing guarded. */
function healthyReport() {
	return {
		sampledAt: new Date().toISOString(),
		workerStale: false,
		packageUpdate: null,
		controller: { reachable: true, errorCode: null },
		host: HOST,
		workspacesByState: { running: 2, stopped: 3 },
		agents: { answering: 2, running: 2 },
		last24h: {
			startFailures: 0,
			stopFailures: 0,
			forcedStops: 0,
			provisionFailures: 0,
			controllerOutages: 0,
			signInFailures: 0,
			previewRefusals: 0,
		},
		guard: [] as unknown[],
	};
}

async function answerHealth(page: Page, report: ReturnType<typeof healthyReport>) {
	await routeApi(page, "**/admin/health", (route) => route.fulfill({ json: report }));
}

/** A report with the student's workspace throttled, the controller down and memory nearly full. */
function troubledReport(student: {
	userId: string;
	workspaceId: string;
	name: string;
}) {
	return {
		...healthyReport(),
		controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
		host: { ...HOST, memory: { usedBytes: 15 * GIB, totalBytes: 16 * GIB } },
		guard: [
			{
				workspaceId: student.workspaceId,
				owner: { id: student.userId, displayName: student.name },
				cpuThrottle: {
					at: new Date().toISOString(),
					thresholdPercent: 80,
					windowMinutes: 30,
					sharePercent: 25,
					averagePercent: 97,
					allowance: "25ms/100ms",
				},
				memoryFlag: null,
			},
		],
	};
}

async function openAttention(page: Page) {
	await page.goto("/admin/health");
	const attention = page.getByRole("region", { name: "Needs attention" });
	await expect(attention).toBeVisible({ timeout: 15_000 });
	return attention;
}

test.describe("Needs attention", () => {
	test("a guarded workspace's name and Inspect open that account on Users", async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "Attention");
		await answerHealth(page, troubledReport(student));
		await loginAs(page, "carol");

		let attention = await openAttention(page);
		await expect(
			attention.getByRole("table", { name: "Throttled and flagged workspaces" }),
		).toContainText(student.name);
		await attention.getByRole("link", { name: student.name, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/admin/users\\?.*user=${student.userId}`));
		await expect(page.getByRole("region", { name: student.name })).toBeVisible({
			timeout: 15_000,
		});

		attention = await openAttention(page);
		await attention
			.getByRole("link", { name: `Inspect ${student.name}'s workspace` })
			.click();
		await expect(page).toHaveURL(new RegExp(`/admin/users\\?.*user=${student.userId}`));
		await expect(page.getByRole("region", { name: student.name })).toBeVisible({
			timeout: 15_000,
		});
	});

	test("a guarded workspace's Logs and Audit open those pages filtered to it", async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "Attention");
		await answerHealth(page, troubledReport(student));
		await loginAs(page, "carol");

		let attention = await openAttention(page);
		await attention
			.getByRole("link", { name: `Logs for ${student.name}'s workspace` })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`/admin/logs\\?.*workspace=${student.workspaceId}`),
		);
		await expect(page.getByRole("checkbox", { name: /^Only .*workspace/ })).toBeChecked(
			{
				timeout: 15_000,
			},
		);

		attention = await openAttention(page);
		await attention
			.getByRole("link", { name: `Audit for ${student.name}'s workspace` })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`/admin/audit\\?.*workspace=${student.workspaceId}`),
		);
		await expect(page.getByTestId("audit-filter-target")).toContainText(
			"Only events about",
			{ timeout: 15_000 },
		);
	});

	test("a problem with no workspace leads to where it can be looked into", async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "Attention");
		await answerHealth(page, troubledReport(student));
		await loginAs(page, "carol");

		let attention = await openAttention(page);
		await attention
			.getByRole("listitem")
			.filter({ hasText: "Controller not reachable" })
			.getByRole("link", { name: "Open Logs" })
			.click();
		await expect(page).toHaveURL(/\/admin\/logs\?/);
		await expect(page.getByRole("heading", { name: "Logs", level: 2 })).toBeVisible();

		attention = await openAttention(page);
		await attention
			.getByRole("listitem")
			.filter({ hasText: "Memory is over 80% full" })
			.getByRole("link", { name: "Open Users" })
			.click();
		await expect(page).toHaveURL(/\/admin\/users/);
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	});

	test("a worker that has never reported is one Worker not reporting item, not an unreachable controller", async ({
		page,
	}) => {
		await answerHealth(page, {
			...healthyReport(),
			sampledAt: null as unknown as string,
			workerStale: true,
			controller: null as unknown as { reachable: boolean; errorCode: null },
			host: null as unknown as typeof HOST,
		});
		await loginAs(page, "carol");

		const attention = await openAttention(page);
		await expect(attention.getByRole("listitem")).toHaveCount(1);
		const item = attention
			.getByRole("listitem")
			.filter({ hasText: "Worker not reporting" });
		await expect(item).toBeVisible();
		await expect(page.getByText("Controller not reachable")).toHaveCount(0);
		await expect(page.getByTestId("health-controller")).toHaveText("Unknown");

		// The rail badge and the status bar count the same one item.
		await expect(page.getByTestId("admin-health-mark")).toContainText("1");
		await expect(page.getByTestId("admin-attention-pill")).toContainText(
			"1 to look at",
		);

		await item.getByRole("link", { name: "Open Logs" }).click();
		await expect(page).toHaveURL(/\/admin\/logs\?.*service=worker/);
		await expect(page.getByRole("heading", { name: "Logs", level: 2 })).toBeVisible();
	});

	test("a sample that says the controller is down still names the controller", async ({
		page,
	}) => {
		await answerHealth(page, {
			...healthyReport(),
			controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
		});
		await loginAs(page, "carol");

		const attention = await openAttention(page);
		await expect(attention.getByRole("listitem")).toHaveCount(1);
		await expect(
			attention.getByRole("listitem").filter({ hasText: "Controller not reachable" }),
		).toBeVisible();
		await expect(page.getByText("Worker not reporting")).toHaveCount(0);
		await expect(page.getByTestId("health-controller")).toContainText(
			"Not reachable (CONTROLLER_UNAVAILABLE)",
		);
		await expect(page.getByTestId("admin-health-mark")).toContainText("1");
		await expect(page.getByTestId("admin-attention-pill")).toContainText(
			"1 to look at",
		);
	});

	test("with nothing to act on it says all is healthy and offers no links", async ({
		page,
	}) => {
		await answerHealth(page, healthyReport());
		await loginAs(page, "carol");
		await page.goto("/admin/health");
		const verdict = page.getByTestId("health-verdict");
		await expect(verdict).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("region", { name: "Needs attention" })).toHaveCount(0);
		await expect(verdict).toContainText("All systems healthy");
		await expect(verdict.getByRole("link")).toHaveCount(0);
	});
});

test.describe("the admin status bar", () => {
	test("shows the host's vitals at the foot of every admin page and leads to Health", async ({
		page,
	}) => {
		await answerHealth(page, healthyReport());
		await loginAs(page, "carol");

		for (const tab of ["users", "settings", "logs"]) {
			await page.goto(`/admin/${tab}`);
			const bar = page.getByTestId("admin-status-bar");
			await expect(bar).toBeVisible({ timeout: 15_000 });
			// It is the page's foot: a contentinfo landmark below the admin content.
			await expect(bar).toHaveRole("contentinfo");
			await expect(bar).toBeInViewport();
			const main = await page.getByRole("main").boundingBox();
			const foot = await bar.boundingBox();
			if (!main || !foot) throw new Error("no box");
			expect(foot.y).toBeGreaterThanOrEqual(main.y + main.height - 1);

			await expect(bar.getByRole("meter", { name: "Host memory" })).toHaveAttribute(
				"aria-valuetext",
				/^6\.0 GB of 16\.0 GB/,
			);
			await expect(bar.getByRole("meter", { name: "Storage pool" })).toHaveAttribute(
				"aria-valuetext",
				/^30\.0 GB of 100 GB/,
			);
			await expect(bar.getByText("2/5", { exact: true })).toBeVisible();
			await expect(bar).toContainText("1.25");
		}

		// From any page one link opens Health.
		await page.goto("/admin/logs");
		const bar = page.getByTestId("admin-status-bar");
		const health = bar.getByRole("link");
		await expect(health).toHaveCount(1);
		await expect(health).toHaveAttribute("href", "/admin/health");
		await health.focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/admin\/health$/);
		await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
	});
});
