import { expect, type Page, test } from "@playwright/test";
import {
	CODE_HELP_SWITCH_LOCK,
	lockSharedState,
	loginAs,
	resetCodeHelpLanguages,
	routeApi,
	SETTINGS_ROW_LOCK,
} from "./helpers";

/**
 * The code-help estimate on the Settings tab reads the server's real memory
 * from the Health report and works out memory per student and students per
 * server for each course profile (docs/CAPACITY.md, "Estimate on the
 * Settings page"). Nothing here saves; the shared code-help lock keeps
 * both languages ticked while the tests run.
 */

const GIB = 1024 ** 3;
let release: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	test.setTimeout(600_000);
	// A spec that changed the set alone may have left it changed; put it back first.
	const row = await lockSharedState(SETTINGS_ROW_LOCK);
	await resetCodeHelpLanguages();
	await row();
	release = await lockSharedState(CODE_HELP_SWITCH_LOCK, { shared: true });
});

test.afterAll(async () => {
	await release?.();
});

/** The Health report with its host memory replaced, or the read failing. */
async function serverMemory(
	page: Page,
	totalBytes: number | null | "fail",
	/** Holds the answer back until this resolves. */
	gate?: Promise<void>,
) {
	await routeApi(page, "**/admin/health", async (route, request) => {
		if (request.method() !== "GET") return route.fallback();
		await gate;
		if (totalBytes === "fail") return route.fulfill({ status: 500, json: {} });
		const response = await route.fetch();
		const report = await response.json();
		const host =
			totalBytes === null
				? null
				: {
						observedAt: new Date().toISOString(),
						loadAverage: [0.5, 0.4, 0.3],
						cpuCount: 4,
						memory: { usedBytes: 2 * GIB, totalBytes },
						pool: {
							name: "portikus",
							usedBytes: 10 * GIB,
							totalBytes: 100 * GIB,
							metadataPercent: 12,
						},
						profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
						image: { fingerprint: "abcdef0123456789abcdef", serial: "2026.09.9" },
						instances: [],
					};
		return route.fulfill({ response, json: { ...report, host } });
	});
}

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const tools = page.getByRole("region", { name: "Student tools" });
	await expect(tools.getByRole("checkbox", { name: "Python" })).toBeChecked({
		timeout: 15_000,
	});
	return tools;
}

/** The table's two rows as [profile, memory, students]. */
async function rows(page: Page) {
	return page
		.getByTestId("code-help-estimate")
		.locator("tbody tr")
		.evaluateAll((trs) =>
			trs.map((tr) =>
				[...tr.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim()),
			),
		);
}

test("at 16 GiB the table follows the ticked boxes before anything is saved", async ({
	page,
}) => {
	await serverMemory(page, 16 * GIB);
	const tools = await open(page);
	const headline = page.getByTestId("code-help-headline");
	await expect(headline).toHaveText(
		"Code help adds at most 242 MiB per student, if every student opens every ticked language.",
	);
	// Only the headline is a live region, not the table.
	await expect(headline).toHaveJSProperty("tagName", "OUTPUT");
	await expect(
		page.getByTestId("code-help-estimate").locator("output table"),
	).toHaveCount(0);
	await expect
		.poll(() => rows(page))
		.toEqual([
			["Traditional, no coding agent", "402 MiB", "about 32"],
			["Agentic, with a coding agent", "552 MiB", "about 23"],
		]);
	await expect(page.getByTestId("code-help-estimate")).toContainText(
		"Worst case, with every ticked language open at once. Memory only. This server has 16 GiB",
	);

	await tools.getByRole("checkbox", { name: "Python" }).click();
	await expect(headline).toHaveText(
		"Code help adds at most 57 MiB per student, if every student opens every ticked language.",
	);
	await expect
		.poll(() => rows(page))
		.toEqual([
			["Traditional, no coding agent", "217 MiB", "about 59"],
			["Agentic, with a coding agent", "367 MiB", "about 35"],
		]);

	await tools.getByRole("checkbox", { name: "TypeScript and JavaScript" }).click();
	await expect(headline).toHaveText(
		"Code help is off. The editor shows syntax colouring only.",
	);
	await expect
		.poll(() => rows(page))
		.toEqual([
			["Traditional, no coding agent", "160 MiB", "about 80"],
			["Agentic, with a coding agent", "310 MiB", "about 41"],
		]);
});

test("at 8 GiB the counts shrink", async ({ page }) => {
	await serverMemory(page, 8 * GIB);
	await open(page);
	await expect
		.poll(() => rows(page))
		.toEqual([
			["Traditional, no coding agent", "402 MiB", "about 11"],
			["Agentic, with a coding agent", "552 MiB", "about 8"],
		]);
});

for (const [name, memory] of [
	["no host in the report", null],
	["the Health read failing", "fail"],
] as const) {
	test(`with ${name}, the memory per student shows and the counts say memory is not known`, async ({
		page,
	}) => {
		await serverMemory(page, memory);
		await open(page);
		await expect
			.poll(() => rows(page))
			.toEqual([
				["Traditional, no coding agent", "402 MiB", "Server memory not known yet"],
				["Agentic, with a coding agent", "552 MiB", "Server memory not known yet"],
			]);
		await expect(page.getByTestId("code-help-estimate")).toContainText(
			"Server memory is not known yet, so the number of students is not shown.",
		);
	});
}

test("while the Health read is still out, the counts are not called unknown", async ({
	page,
}) => {
	let letGo: () => void = () => {};
	const held = new Promise<void>((done) => {
		letGo = done;
	});
	await serverMemory(page, 16 * GIB, held);
	await open(page);
	const estimate = page.getByTestId("code-help-estimate");
	// The memory per student needs no server figure, so it is already there.
	await expect(estimate).toContainText("402 MiB");
	await expect(estimate).not.toContainText("not known");
	await expect(estimate).not.toContainText(/about \d+/);
	letGo();
	await expect
		.poll(() => rows(page), { timeout: 15_000 })
		.toEqual([
			["Traditional, no coding agent", "402 MiB", expect.stringMatching(/^about \d+$/)],
			["Agentic, with a coding agent", "552 MiB", expect.stringMatching(/^about \d+$/)],
		]);
	await expect(estimate).not.toContainText("not known");
});
