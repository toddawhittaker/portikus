import { expect, test } from "@playwright/test";
import { loginAs, query } from "./helpers";

/**
 * The API request charts on the Health tab (docs/EPIC-19.md ruling 25,
 * issue #599). The running API also writes its own per-minute totals, so the
 * seeded minute is large enough that its figures dominate any real traffic
 * added to it, and the assertions allow for that.
 */
test.describe.configure({ mode: "serial" });

const OVERFLOW = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60_000];

test.describe("admin health API charts", () => {
	test.beforeEach(async () => {
		await query("delete from api_request_samples");
	});

	test.afterAll(async () => {
		await query("delete from api_request_samples");
	});

	test("the three API charts describe the seeded traffic", async ({ page }) => {
		await query(
			`insert into api_request_samples
				(minute, requests, client_errors, server_errors, websocket_upgrades, latency_buckets)
			 values (date_trunc('minute', now()) - interval '30 minutes', 60000, 0, 30000, 1000, $1)`,
			[OVERFLOW],
		);

		await loginAs(page, "carol");
		await page.goto("/admin?tab=health");
		await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
		await page.getByRole("button", { name: "1 hour" }).click();

		const requests = page.getByTestId("health-chart-api-requests");
		await expect(
			requests.getByRole("img", {
				name: /^API requests: Now [\d,.]+\/min, highest 60,\d{3}\/min\. 1,\d{3} WebSocket upgrades in this range\.$/,
			}),
		).toBeVisible();
		await expect(
			page.getByTestId("health-chart-api-errors").getByRole("img", {
				name: /^API error rate: 4xx: .* 5xx: Now [\d.]+%, highest (49|50)%\.$/,
			}),
		).toBeVisible();
		await expect(
			page.getByTestId("health-chart-api-latency").getByRole("img", {
				name: /^API response time: Median: .*highest 10,000 ms\. 95th percentile: .*highest 10,000 ms\.$/,
			}),
		).toBeVisible();
	});
});
