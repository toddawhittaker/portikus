import { expect, type Page, test } from "@playwright/test";
import { loginAs, openToggletip, query, settledAxe, WCAG_TAGS } from "./helpers";

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

/** A sample with Epic 19's host rates and running count (#598 items 2, 6 to 8). */
async function seedPlatformSample(
	minutesAgo: number,
	reachable: boolean,
): Promise<void> {
	const base = sample(40);
	const value = reachable
		? {
				...base,
				host: {
					...base.host,
					rates: {
						cpuPercent: 37,
						netRxBytesPerSecond: 2 * 1024 * 1024,
						netTxBytesPerSecond: 1024 * 1024,
						diskReadBytesPerSecond: 512 * 1024,
						diskWriteBytesPerSecond: 256 * 1024,
					},
				},
				runningWorkspaces: 3,
			}
		: {
				controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
				host: null,
				runningWorkspaces: 3,
			};
	await query(
		`insert into health_samples (observed_at, sample)
		 values (now() - make_interval(mins => $1), $2)`,
		[minutesAgo, JSON.stringify(value)],
	);
}

async function openHealth(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=health");
	await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("health-trends")).toBeVisible();
}

function poolChart(page: Page) {
	return page.getByTestId("health-chart-pool");
}

/** The pool chart's X-axis and Y-axis labels, in drawing order. */
async function axisLabels(page: Page): Promise<string[]> {
	return poolChart(page).locator("svg text").allTextContents();
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
		await expect(page.getByTestId("health-pool-warning")).toHaveClass(
			/pk-tag pk-tag--warning/,
		);
		await expect(
			page.getByRole("img", { name: /^Storage pool used, %: Now 85%, highest 85%\.$/ }),
		).toBeVisible();
	});

	for (const width of [1280, 1920]) {
		test(`four cards sit in one row at a glance, above the trends, at ${width} px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 1000 });
			await seedSample(50, 0);
			await openHealth(page);

			const box = async (name: string) => {
				const found = await page
					.locator(`section[aria-labelledby="health-${name}-title"]`)
					.boundingBox();
				if (!found) throw new Error(`${name} has no box`);
				return found;
			};
			const cards = await Promise.all(
				["platform", "guard", "counts", "states"].map((name) => box(name)),
			);
			for (const card of cards) expect(card.y).toBe(cards[0]?.y);
			for (let i = 1; i < cards.length; i++)
				expect(cards[i]?.x).toBeGreaterThan(cards[i - 1]?.x ?? 0);
			const tallest = Math.max(...cards.map((card) => card.y + card.height));
			const trends = await box("trends");
			expect(trends.y).toBeGreaterThan(tallest - 1);
			const packages = await box("packages");
			expect(packages.y).toBeGreaterThan(trends.y + trends.height - 1);
			// At least two charts per row inside the Trends card.
			const pool = await poolChart(page).boundingBox();
			const memory = await page.getByTestId("health-chart-memory").boundingBox();
			expect(memory?.y).toBe(pool?.y);
		});
	}

	test("at 1024 px nothing overflows, and the axis text is 12 px and inside the chart", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 900 });
		await seedPlatformSample(1, true);
		await seedPlatformSample(0, true);
		await openHealth(page);

		for (const name of ["platform", "guard", "counts", "states"]) {
			const card = page.locator(`section[aria-labelledby="health-${name}-title"]`);
			const fits = await card.evaluate((el) => el.scrollWidth <= el.clientWidth);
			expect(fits, `${name} fits its card`).toBe(true);
		}
		const network = page.getByTestId("health-chart-network");
		await expect(network.locator("figcaption")).toHaveText(
			"Network on the default interface, MB/s",
		);
		const labels = await network.locator('svg text[data-axis="y"]').allTextContents();
		expect(labels).toEqual(["0", "0.5", "1", "1.5", "2"]);
		const inside = await network.locator("svg[role=img]").evaluate((svg) => {
			const frame = svg.getBoundingClientRect();
			return [...svg.querySelectorAll("text")].every((text) => {
				const box = text.getBoundingClientRect();
				const size = Number.parseFloat(getComputedStyle(text).fontSize);
				return (
					box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5 && size >= 12
				);
			});
		});
		expect(inside).toBe(true);
		// Drawn at its real width, so 12 px text stays 12 px on screen.
		const scale = await network.locator("svg[role=img]").evaluate((svg) => {
			const view = (svg as SVGSVGElement).viewBox.baseVal.width;
			return svg.getBoundingClientRect().width / view;
		});
		expect(scale).toBeCloseTo(1, 1);
	});

	test("a chart with no samples shows one line and no axis", async ({ page }) => {
		// A sample without Epic 19's host rates: CPU, network and disk have none.
		await seedSample(50, 0);
		await openHealth(page);

		const cpu = page.getByTestId("health-chart-cpu");
		await expect(cpu.getByTestId("health-chart-cpu-summary")).toHaveText(
			"No samples in this range.",
		);
		await expect(cpu.locator("svg")).toHaveCount(0);
		await expect(page.getByTestId("health-chart-cpu-plot")).toHaveCount(0);
	});

	test("the trend groups start open, and a closed group stays closed after a reload", async ({
		page,
	}) => {
		await seedSample(50, 0);
		await openHealth(page);

		const groups = ["Host", "Workspaces", "API", "Events"];
		for (const name of groups) {
			const heading = page.getByRole("heading", { level: 4, name, exact: true });
			await expect(heading).toBeVisible();
		}
		const host = page.getByTestId("health-group-host");
		await expect(host).toHaveAttribute("open", "");
		await host.locator("summary").focus();
		await page.keyboard.press("Enter");
		await expect(host).not.toHaveAttribute("open");
		await expect(poolChart(page)).toHaveCount(0);

		await page.reload();
		await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("health-group-host")).not.toHaveAttribute("open");
		await expect(page.getByTestId("health-group-api")).toHaveAttribute("open", "");

		await page.getByTestId("health-group-host").locator("summary").click();
		await expect(poolChart(page)).toBeVisible();
	});

	test("switching the range changes the axis and the summary, and is remembered", async ({
		page,
	}) => {
		await seedSample(95, 2 * 24 * 60);
		await seedSample(40, 30);
		await seedSample(85, 0);
		await openHealth(page);

		await expect(page.getByRole("button", { name: "1 day" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(poolChart(page).getByTestId("health-chart-pool-summary")).toHaveText(
			"Now 85%, highest 85%.",
		);
		const dayLabels = await axisLabels(page);

		await page.getByRole("button", { name: "7 days" }).click();
		await expect(poolChart(page).getByTestId("health-chart-pool-summary")).toHaveText(
			"Now 85%, highest 95%.",
		);
		const weekLabels = await axisLabels(page);
		expect(weekLabels).not.toEqual(dayLabels);
		// Weekday and date, not clock times.
		expect(weekLabels.some((label) => label.includes(":"))).toBe(false);

		await page.getByRole("button", { name: "1 hour" }).click();
		await expect(page.getByRole("button", { name: "1 hour" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect.poll(() => axisLabels(page)).not.toEqual(dayLabels);

		await page.reload();
		await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "1 hour" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	test("the chart's readout works from the keyboard", async ({ page }) => {
		// Two samples, so the bucket before the newest has data even when the
		// page loads just after a minute boundary.
		await seedSample(42, 1);
		await seedSample(42, 0);
		await openHealth(page);
		await page.getByRole("button", { name: "1 hour" }).click();
		// Wait for the 1-hour data, not the previous range kept on screen.
		await expect(page.getByTestId("health-trends")).toHaveAttribute(
			"aria-busy",
			"false",
		);
		await expect(
			page.getByTestId("health-chart-pool").locator("svg text"),
		).toContainText([/:/]);

		const plot = page.getByRole("application", {
			name: "Storage pool used, %, use the left and right arrow keys to read values",
		});
		await plot.focus();
		await page.keyboard.press("End");
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("health-chart-pool-readout")).toHaveText(/, 42%$/);
		await page.keyboard.press("Home");
		await expect(page.getByTestId("health-chart-pool-readout")).toHaveText(
			/, no data$/,
		);
		await page.keyboard.press("ArrowRight");
		await expect(page.getByTestId("health-chart-pool-cursor")).toHaveCount(1);
	});

	for (const colorScheme of ["light", "dark"] as const) {
		test(`the tab has no automatic violations (${colorScheme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme });
			await seedSample(85, 0);
			await openHealth(page);
			const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		});

		test(`the intro and an open help tip have no automatic violations (${colorScheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme });
			await seedSample(85, 0);
			await openHealth(page);
			await expect(page.getByTestId("intro-admin-health")).toBeVisible();
			await page.getByRole("button", { name: "About Storage pool" }).click();
			await expect(openToggletip(page)).toBeVisible();
			const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		});
	}

	test("the intro links to Help, and each help tip opens from the keyboard", async ({
		page,
	}) => {
		await seedSample(50, 0);
		await openHealth(page);

		const intro = page.getByTestId("intro-admin-health");
		await expect(intro).toContainText(
			"How the platform is doing right now and over time.",
		);
		await expect(intro.getByRole("link", { name: /More in Help/ })).toHaveAttribute(
			"href",
			"/help#admin-health",
		);

		const tips: [string, RegExp][] = [
			["Agents answering", /Fewer answering than running/],
			["Load average", /Above the CPU count means work is waiting/],
			["Storage pool", /warns at 70% full, and at 90% new workspaces are refused/],
			["Pool metadata", /It can fill before the data does/],
			["Workspace limits", /unless its panel on the Users tab sets its own/],
		];
		for (const [label, text] of tips) {
			const button = page.getByRole("button", { name: `About ${label}` });
			await button.focus();
			await page.keyboard.press("Enter");
			await expect(openToggletip(page)).toContainText(text);
			await page.keyboard.press("Escape");
			await expect(openToggletip(page)).toHaveCount(0);
			await expect(button).toBeFocused();
		}
	});

	test("a sample 3 minutes old shows Worker not reporting", async ({ page }) => {
		await seedSample(50, 3);

		await openHealth(page);

		const banner = page.getByTestId("health-worker-stale");
		await expect(banner).toContainText("Worker not reporting.");
		await expect(banner).toContainText("3 minutes ago");
		await expect(page.getByTestId("health-pool-warning")).toHaveCount(0);
	});

	test("the platform charts show availability, running count, CPU, network and disk", async ({
		page,
	}) => {
		for (let minutes = 0; minutes <= 9; minutes++)
			await seedPlatformSample(minutes, true);
		for (const minutes of [20, 21, 22]) await seedPlatformSample(minutes, false);
		await openHealth(page);
		await page.getByRole("button", { name: "1 hour" }).click();
		await expect(page.getByTestId("health-trends")).toHaveAttribute(
			"aria-busy",
			"false",
		);

		await expect(page.getByTestId("health-chart-availability-summary")).toHaveText(
			"Samples in 13 of 60 minutes; controller unreachable for 3.",
		);
		const strip = page.getByTestId("health-chart-availability");
		await expect(strip.locator("[data-part=outage]")).toHaveCount(3);
		await expect(
			strip.getByText("Controller unreachable", { exact: true }),
		).toBeVisible();
		// Outages carry a pattern, not only a colour.
		await expect(strip.locator("[data-part=outage]").first()).toHaveCSS(
			"fill",
			/url\(/,
		);
		await expect(page.getByTestId("health-chart-running-summary")).toHaveText(
			"Now 3, highest 3.",
		);
		await expect(page.getByTestId("health-chart-cpu-summary")).toHaveText(
			"Now 37%, highest 37%.",
		);
		await expect(page.getByTestId("health-chart-network-summary")).toHaveText(
			"In: Now 2 MB/s, highest 2 MB/s. Out: Now 1 MB/s, highest 1 MB/s.",
		);
		await expect(page.getByTestId("health-chart-disk-summary")).toHaveText(
			"Read: Now 512 KB/s, highest 512 KB/s. Write: Now 256 KB/s, highest 256 KB/s.",
		);
		await expect(
			page.getByTestId("health-chart-network").locator("figcaption"),
		).toHaveText("Network on the default interface, MB/s");
		// A missing sample is a quiet dot; red is kept for the controller being down.
		await expect(strip.locator("[data-part=gap]").first()).toBeVisible();
		await expect(strip.locator("#health-strip-gap circle")).toHaveClass(
			"fill-ink-faint",
		);
		const [gapFill, outageFill] = await strip.evaluate((el) => [
			getComputedStyle(el.querySelector("#health-strip-gap circle") as Element).fill,
			getComputedStyle(el.querySelector("#health-strip-outage rect") as Element).fill,
		]);
		expect(gapFill).not.toBe(outageFill);

		const cpu = page.getByRole("application", {
			name: "Host CPU used, %, use the left and right arrow keys to read values",
		});
		await cpu.focus();
		await page.keyboard.press("End");
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("health-chart-cpu-readout")).toHaveText(/, 37%$/);

		await page
			.getByRole("application", {
				name: "Sampling and controller availability, % of minutes, use the left and right arrow keys to read values",
			})
			.focus();
		await page.keyboard.press("End");
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("health-chart-availability-readout")).toHaveText(
			/, samples in 1 of 1 minutes, controller unreachable for 0$/,
		);
	});
});
