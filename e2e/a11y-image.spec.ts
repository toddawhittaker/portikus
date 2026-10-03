import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs, openToggletip, routeApi } from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Workspace
 * image tab and its dialogs, in both themes (docs/SPEC.md section 22.4). The page
 * is served fixed answers in the browser, because admin-image.spec.ts owns
 * the fake job directory and runs its tests in order against it.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function image(
	version: string,
	role: string,
	health: "passed" | "failed",
	workspaces: number,
) {
	return {
		version,
		role,
		manifest: {
			schema: 1,
			version,
			recipeVersion: "2026.09.9",
			source: version.includes("-local.") ? "local" : "published",
			builtAt: "2026-09-20T10:00:00.000Z",
			fingerprint: null,
			parameters: { node: "24", python: "debian" },
			tools: {
				node: "v24.8.0",
				npm: "11.6.0",
				python3: "Python 3.13.5",
				git: "git version 2.47.3",
				docker: "Docker version 28.4.0",
				claude: "2.0.1 (Claude Code)",
				codex: "codex-cli 0.40.0",
			},
			packageCount: 412,
		},
		health: { result: health, checkedAt: "2026-09-28T10:00:00.000Z", checks: [] },
		workspaces,
		sizeBytes: 880803840,
	};
}

const JOB = {
	id: JOB_ID,
	kind: "fetch",
	state: "succeeded",
	step: "Done",
	version: "2026.09.10",
	message: null,
	requestedAt: "2026-09-28T09:59:00.000Z",
	startedAt: "2026-09-28T10:00:00.000Z",
	finishedAt: "2026-09-28T10:04:00.000Z",
	request: { kind: "fetch" },
};

const IMAGE = {
	default: "2026.09.9",
	previous: "2026.09.8",
	images: [
		image("2026.09.9", "default", "passed", 12),
		image("2026.09.8", "previous", "passed", 3),
		image("2026.09.10", "candidate", "passed", 0),
		image("2026.09.9-local.202609271200", "candidate", "failed", 0),
	],
	otherWorkspaces: 2,
	job: JOB,
	// The notice at the top is checked with the rest of the page.
	newerPublished: "2026.09.11",
	disk: { freeBytes: 5368709120, totalBytes: 21474836480 },
};

const DIFF = {
	from: "2026.09.9",
	to: "2026.09.10",
	tools: {
		added: [],
		removed: [],
		changed: [{ name: "node", from: "v24.8.0", to: "v24.9.0" }],
	},
	packages: {
		added: [{ name: "zsh", version: "5.9-8" }],
		removed: [{ name: "vim-tiny", version: "2:9.1" }],
		changed: [{ name: "curl", from: "8.14.1-2", to: "8.14.1-3" }],
	},
};

const RUNNING_JOB = {
	...JOB,
	kind: "build",
	state: "running",
	step: "Installing packages",
	version: null,
	finishedAt: null,
	request: { kind: "build", node: "24", python: "debian" },
};

const FAILED_JOB = {
	...JOB,
	state: "failed",
	step: "Checking the signature",
	message: "The image signature did not match the published key.",
};

async function routeImage(page: Page, job: object) {
	await routeApi(page, "**/admin/image", (route) =>
		route.fulfill({ json: { ...IMAGE, job } }),
	);
	await page.route(`**/admin/image/jobs/${JOB_ID}`, (route) =>
		route.fulfill({ json: { job, log: ["fetching"] } }),
	);
}

async function openTab(page: Page, colorScheme: "light" | "dark") {
	await routeApi(page, "**/admin/image", (route) => route.fulfill({ json: IMAGE }));
	await page.route("**/admin/image/diff?**", (route) => route.fulfill({ json: DIFF }));
	await page.route(`**/admin/image/jobs/${JOB_ID}`, (route) =>
		route.fulfill({
			json: { job: JOB, log: ["fetching", "signature good", "health passed"] },
		}),
	);
	await page.emulateMedia({ colorScheme });
	await loginAs(page, "carol");
	await page.goto("/admin/image");
	await expect(page.getByTestId("image-job-result")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("image-job-result").getByText("zsh")).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Workspace image tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme);
		await expect(page.getByTestId("intro-admin-image")).toBeVisible();
		await expectNoViolations(page);
		// A toggletip opens and Escape closes it back onto its button.
		const tip = page.getByRole("button", { name: "About the health check" });
		await tip.click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(openToggletip(page)).toHaveCount(0);
		await expect(tip).toBeFocused();
		// The log takes focus, so it can be scrolled from the keyboard.
		await page.getByTestId("image-job-log").focus();
		await expect(page.getByTestId("image-job-log")).toBeFocused();
	});

	test(`the Workspace image dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme);

		await page.getByRole("button", { name: "Rebuild with latest packages" }).click();
		const rebuild = page.getByTestId("image-rebuild-dialog");
		await expect(rebuild).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(rebuild).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Rebuild with latest packages" }),
		).toBeFocused();

		await page.getByRole("button", { name: "Show changes in 2026.09.10" }).click();
		const diff = page.getByTestId("image-diff-dialog");
		await expect(diff.getByText("vim-tiny")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(diff).toHaveCount(0);

		await page.getByRole("button", { name: "Roll back" }).click();
		await expect(page.getByTestId("image-confirm")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("image-confirm")).toHaveCount(0);
		// Delete confirms with the count of workspaces made from the image.
		const remove = page.getByRole("button", { name: "Delete: 2026.09.10" });
		await remove.click();
		await expect(page.getByTestId("image-confirm")).toContainText(
			"No workspaces were made from this image.",
		);
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("image-confirm")).toHaveCount(0);
		await expect(remove).toBeFocused();
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a running job has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeImage(page, RUNNING_JOB);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/image");
		await expect(page.getByTestId("image-job-state")).toContainText(
			"Installing packages",
		);
		await expectNoViolations(page);
	});

	test(`a failed job reads its reason and has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeImage(page, FAILED_JOB);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/image");
		// The status region carries the reason, so a screen reader hears why.
		await expect(page.getByTestId("image-job-state")).toContainText(FAILED_JOB.message);
		await expectNoViolations(page);
	});

	test(`image management turned off has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeApi(page, "**/admin/image", (route) =>
			route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Not found" } }),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/image");
		await expect(page.getByTestId("image-off")).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page);
	});

	test(`a failed image request has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeApi(page, "**/admin/image", (route) =>
			route.fulfill({
				status: 500,
				json: { code: "INTERNAL", message: "The image list could not be read." },
			}),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/image");
		await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("image-off")).toHaveCount(0);
		await expectNoViolations(page);
	});
}

test("Make default from the table sends focus to the job heading, not the page", async ({
	page,
}) => {
	let job: object = JOB;
	await routeApi(page, "**/admin/image", (route) =>
		route.fulfill({ json: { ...IMAGE, job } }),
	);
	await page.route("**/admin/image/diff?**", (route) => route.fulfill({ json: DIFF }));
	await page.route("**/admin/image/jobs/*", (route) =>
		route.fulfill({ json: { job, log: ["x"] } }),
	);
	await page.route("**/admin/image/jobs", (route) => {
		job = {
			...JOB,
			id: "22222222-2222-4222-8222-222222222222",
			kind: "activate",
			state: "queued",
			step: "Waiting",
			startedAt: null,
			finishedAt: null,
			request: { kind: "activate", version: "2026.09.10" },
		};
		return route.fulfill({ status: 202, json: job });
	});
	await loginAs(page, "carol");
	await page.goto("/admin/image");
	const make = page
		.getByTestId("image-row-2026.09.10")
		.getByRole("button", { name: "Make default: 2026.09.10" });
	await make.focus();
	await page.keyboard.press("Enter");
	await page.getByTestId("image-confirm").getByTestId("dialog-confirm").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("image-confirm")).toHaveCount(0);
	await expect(page.locator("#image-job-title")).toBeFocused();
});

test("Update from the newer-image notice sends focus to the job heading once the notice goes", async ({
	page,
}) => {
	let current: object = { ...IMAGE, job: null };
	await routeApi(page, "**/admin/image", (route) => route.fulfill({ json: current }));
	await page.route("**/admin/image/jobs/*", (route) =>
		route.fulfill({ json: { job: RUNNING_JOB, log: ["x"] } }),
	);
	await page.route("**/admin/image/jobs", (route) => {
		// The fetch has started; the notice clears once the image is on the server.
		current = { ...IMAGE, newerPublished: null, job: RUNNING_JOB };
		return route.fulfill({ status: 202, json: { ...RUNNING_JOB, state: "queued" } });
	});
	await loginAs(page, "carol");
	await page.goto("/admin/image");
	const update = page
		.getByTestId("image-newer-published")
		.getByRole("button", { name: "Update to 2026.09.11" });
	await update.focus();
	await page.keyboard.press("Enter");
	await page.getByTestId("image-confirm").getByTestId("dialog-confirm").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("image-confirm")).toHaveCount(0);
	await expect(page.getByTestId("image-newer-published")).toHaveCount(0);
	await expect(page.locator("#image-job-title")).toBeFocused();
});

test("Delete sends focus to the job heading once the deleted row goes", async ({
	page,
}) => {
	let current: object = { ...IMAGE, newerPublished: null, job: null };
	const deleting = {
		...RUNNING_JOB,
		kind: "delete",
		step: "Deleting",
		version: "2026.09.10",
		request: { kind: "delete", version: "2026.09.10" },
	};
	await routeApi(page, "**/admin/image", (route) => route.fulfill({ json: current }));
	await page.route("**/admin/image/jobs/*", (route) =>
		route.fulfill({ json: { job: deleting, log: ["x"] } }),
	);
	await page.route("**/admin/image/jobs", (route) => {
		// The row is gone once the delete is queued, taking its Delete button with it.
		current = {
			...IMAGE,
			newerPublished: null,
			images: IMAGE.images.filter((each) => each.version !== "2026.09.10"),
			job: deleting,
		};
		return route.fulfill({ status: 202, json: { ...deleting, state: "queued" } });
	});
	await loginAs(page, "carol");
	await page.goto("/admin/image");
	const remove = page.getByRole("button", { name: "Delete: 2026.09.10" });
	await remove.focus();
	await page.keyboard.press("Enter");
	await page.getByTestId("image-confirm").getByTestId("dialog-confirm").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("image-confirm")).toHaveCount(0);
	await expect(remove).toHaveCount(0);
	await expect(page.locator("#image-job-title")).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`a nearly full main disk says so in words, not by colour alone (${colorScheme})`, async ({
		page,
	}) => {
		await routeApi(page, "**/admin/image", (route) =>
			route.fulfill({
				json: {
					...IMAGE,
					disk: { freeBytes: 2 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
				},
			}),
		);
		await page.route(`**/admin/image/jobs/${JOB_ID}`, (route) =>
			route.fulfill({ json: { job: JOB, log: ["x"] } }),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/image");
		const disk = page.getByRole("meter", { name: "Main disk space" });
		await expect(disk).toHaveAttribute(
			"aria-valuetext",
			"18.0 GB of 20.0 GB used, 2.0 GB free, nearly full",
		);
		const row = page.getByTestId("image-disk-free");
		await expect(row).toContainText(
			"18.0 GB of 20.0 GB used, 2.0 GB free, nearly full",
		);
		await expect(row.locator('[data-icon="alert"]')).toBeVisible();
		// The row label and the meter's name are the same words.
		await expect(
			page.getByRole("term").filter({ hasText: /^Main disk space$/ }),
		).toBeVisible();
		await expectNoViolations(page);
		await row.screenshot({
			path: `screenshots/meter-nearly-full-wide-${colorScheme}.png`,
		});
	});
}
