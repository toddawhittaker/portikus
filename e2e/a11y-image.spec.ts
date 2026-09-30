import { expect, type Page, test } from "@playwright/test";
import { loginAs, openToggletip, settledAxe, WCAG_TAGS } from "./helpers";

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
	// The notice at the top is checked with the rest of the page (issue #861).
	newerPublished: "2026.09.11",
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
	await page.route("**/admin/image", (route) =>
		route.fulfill({ json: { ...IMAGE, job } }),
	);
	await page.route(`**/admin/image/jobs/${JOB_ID}`, (route) =>
		route.fulfill({ json: { job, log: ["fetching"] } }),
	);
}

async function openTab(page: Page, colorScheme: "light" | "dark") {
	await page.route("**/admin/image", (route) => route.fulfill({ json: IMAGE }));
	await page.route("**/admin/image/diff?**", (route) => route.fulfill({ json: DIFF }));
	await page.route(`**/admin/image/jobs/${JOB_ID}`, (route) =>
		route.fulfill({
			json: { job: JOB, log: ["fetching", "signature good", "health passed"] },
		}),
	);
	await page.emulateMedia({ colorScheme });
	await loginAs(page, "carol");
	await page.goto("/admin?tab=image");
	await expect(page.getByTestId("image-job-result")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("image-job-result").getByText("zsh")).toBeVisible();
}

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
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
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a running job has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routeImage(page, RUNNING_JOB);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=image");
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
		await page.goto("/admin?tab=image");
		// The status region carries the reason, so a screen reader hears why.
		await expect(page.getByTestId("image-job-state")).toContainText(FAILED_JOB.message);
		await expectNoViolations(page);
	});

	test(`image management turned off has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.route("**/admin/image", (route) =>
			route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Not found" } }),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=image");
		await expect(page.getByTestId("image-off")).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page);
	});

	test(`a failed image request has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.route("**/admin/image", (route) =>
			route.fulfill({
				status: 500,
				json: { code: "INTERNAL", message: "The image list could not be read." },
			}),
		);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=image");
		await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("image-off")).toHaveCount(0);
		await expectNoViolations(page);
	});
}

test("Make default from the table sends focus to the job heading, not the page", async ({
	page,
}) => {
	let job: object = JOB;
	await page.route("**/admin/image", (route) =>
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
	await page.goto("/admin?tab=image");
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
	await page.route("**/admin/image", (route) => route.fulfill({ json: current }));
	await page.route("**/admin/image/jobs/*", (route) =>
		route.fulfill({ json: { job: RUNNING_JOB, log: ["x"] } }),
	);
	await page.route("**/admin/image/jobs", (route) => {
		// The fetch has started; the notice clears once the image is on the server.
		current = { ...IMAGE, newerPublished: null, job: RUNNING_JOB };
		return route.fulfill({ status: 202, json: { ...RUNNING_JOB, state: "queued" } });
	});
	await loginAs(page, "carol");
	await page.goto("/admin?tab=image");
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
