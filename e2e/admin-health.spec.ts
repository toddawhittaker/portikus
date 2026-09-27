import { expect, type Page, test } from "@playwright/test";
import { loginAs, query } from "./helpers";

/**
 * The Health tab (SPEC.md §25.6). No worker runs in e2e, so each test writes
 * the `health_samples` rows the worker would. The tests share that table, so
 * they run one after another; `--repeat-each` needs `--workers=1` here.
 */
test.describe.configure({ mode: "serial" });

const GIB = 1024 ** 3;

function sample(poolUsedGiB: number, metadataPercent: number | null = 12) {
	return {
		controller: { reachable: true, errorCode: null },
		host: {
			observedAt: new Date().toISOString(),
			loadAverage: [0.5, 0.4, 0.3],
			cpuCount: 4,
			memory: { usedBytes: 4 * GIB, totalBytes: 16 * GIB },
			pool: {
				name: "portikus",
				usedBytes: poolUsedGiB * GIB,
				totalBytes: 100 * GIB,
				metadataPercent,
			},
			profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
			image: { fingerprint: "abcdef0123456789abcdef", serial: "2026.09.9" },
			instances: [],
		},
	};
}

async function seedSample(
	poolUsedGiB: number,
	minutesAgo: number,
	metadataPercent?: number | null,
): Promise<void> {
	await query(
		`insert into health_samples (observed_at, sample)
		 values (now() - make_interval(mins => $1), $2)`,
		[minutesAgo, JSON.stringify(sample(poolUsedGiB, metadataPercent))],
	);
}

async function openHealth(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=health");
	await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
}

test.describe("admin health", () => {
	test.beforeEach(async () => {
		await query("delete from health_samples");
	});

	test.afterAll(async () => {
		await query("delete from health_samples");
	});

	test("a pool at 70 percent is flagged in words, and metadata use is shown", async ({
		page,
	}) => {
		await seedSample(70, 0, 30);

		await openHealth(page);

		await expect(page.getByTestId("health-pool")).toContainText("(70%)");
		await expect(page.getByTestId("health-pool-metadata")).toHaveText("30% used");
		await expect(page.getByTestId("health-pool-warning")).toHaveText(
			"Storage pool is over 70% full",
		);
	});

	test("metadata over 70 percent flags the pool even with data room", async ({
		page,
	}) => {
		await seedSample(20, 0, 75.4);

		await openHealth(page);

		await expect(page.getByTestId("health-pool")).toContainText("(20%)");
		await expect(page.getByTestId("health-pool-metadata")).toHaveText("75% used");
		await expect(page.getByTestId("health-pool-warning")).toHaveText(
			"Storage pool metadata is over 70% full",
		);
	});

	test("a pool at 85 percent is flagged, and the chart has a text alternative", async ({
		page,
	}) => {
		await seedSample(60, 30);
		await seedSample(85, 0);

		await openHealth(page);

		await expect(page.getByTestId("health-pool")).toContainText("(85%)");
		await expect(page.getByTestId("health-pool-warning")).toHaveText(
			"Storage pool is over 70% full",
		);
		await expect(page.getByTestId("health-memory-warning")).toHaveCount(0);
		await expect(page.getByTestId("health-worker-stale")).toHaveCount(0);
		await expect(page.getByTestId("health-image")).toContainText("2026.09.9");
		await expect(
			page.getByRole("img", { name: /^Storage pool used: Now 85%, highest 85%\.$/ }),
		).toBeVisible();
	});

	test("a sample 3 minutes old shows Worker not reporting", async ({ page }) => {
		await seedSample(50, 3);

		await openHealth(page);

		const banner = page.getByTestId("health-worker-stale");
		await expect(banner).toContainText("Worker not reporting.");
		await expect(banner).toContainText("3 minutes ago");
		await expect(page.getByTestId("health-pool-warning")).toHaveCount(0);
	});
});
