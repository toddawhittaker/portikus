import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	makeWorkspace,
	open,
	putSeed,
	seedList,
	setSeedList,
	useDockerState,
} from "./admin-docker-helpers";
import {
	expectNoViolations,
	loginAs,
	openToggletip,
	query,
	routeApi,
	WEB_ORIGIN,
} from "./helpers";
import {
	registryRequests,
	takeRegistryRequest,
	writeRegistryStatus,
} from "./registry-jobs";

/** The Docker tab's pull cache, accounts, image use and accessibility. The seed is in admin-docker-seed.spec.ts. */

useDockerState();

test("the cache's space and last clear show, and Clear cache asks before it sends", async ({
	page,
}) => {
	await writeRegistryStatus({
		usedBytes: 3 * 1024 ** 3,
		lastClearedAt: "2026-09-29T10:00:00.000Z",
		lastClearReason: "full",
	});
	await open(page);
	await expect(page.getByRole("meter", { name: "Pull cache space" })).toHaveAttribute(
		"aria-valuetext",
		"3.0 GB of 20.0 GB used",
	);
	await expect(page.getByTestId("docker-cache-space")).toContainText(
		"3.0 GB of 20.0 GB used",
	);
	await expect(page.getByTestId("docker-cache-hub")).toHaveText("Answering");
	await expect(page.getByTestId("docker-cache-cleared")).toContainText(
		"cleared because it was nearly full",
	);

	await page.getByRole("button", { name: "Clear cache…" }).click();
	const dialog = page.getByTestId("docker-cache-clear-dialog");
	await expect(dialog).toContainText("Every cached image is deleted");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(await registryRequests()).toEqual([]);

	await page.getByRole("button", { name: "Clear cache…" }).click();
	await dialog.getByRole("button", { name: "Clear cache" }).click();
	expect(await takeRegistryRequest()).toEqual({ kind: "clear" });
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Clear cache…" })).toBeFocused();
});

test("before the helper first reports, the page says so", async ({ page }) => {
	await open(page);
	await expect(page.getByTestId("docker-cache-unknown")).toContainText(
		"has not reported yet",
	);
	await expect(page.getByTestId("docker-hub-state")).toContainText("No account is set");
});

test("the Docker Hub account is write-only: refusals, set, never shown, removed", async ({
	page,
}) => {
	await writeRegistryStatus();
	await open(page);
	const card = page.getByTestId("docker-hub");
	await expect(card).toContainText('"Public Repo Read-only" scope');
	await expect(page.getByTestId("docker-hub-warning")).toContainText(
		"use an account with no private repositories",
	);
	await expect(page.getByTestId("docker-hub-warning")).toContainText(
		"empties the cache",
	);

	await card.getByLabel("Docker Hub username").fill("No Such User");
	await card.getByLabel("Access token").fill("short");
	await card.getByRole("button", { name: "Save account" }).click();
	await expect(card.getByText(/4 to 30 lowercase letters/)).toBeVisible();
	await expect(card.getByText(/8 to 200 characters/)).toBeVisible();
	expect(await registryRequests()).toEqual([]);

	const token = `fake-token-${randomUUID()}`;
	await card.getByLabel("Docker Hub username").fill("teacher01");
	await card.getByLabel("Access token").fill(token);
	await card.getByRole("button", { name: "Save account" }).click();
	expect(await takeRegistryRequest()).toEqual({
		kind: "set-hub-credential",
		username: "teacher01",
		token,
	});
	await expect(card.getByLabel("Access token")).toHaveValue("");
	await expect(page.getByTestId("docker-hub-waiting")).toBeVisible();

	// The helper applies it; the page learns only that one is set.
	await writeRegistryStatus({ hubCredentialSet: true, lastClearReason: "credential" });
	await page.reload();
	await expect(page.getByTestId("docker-hub-state")).toContainText("An account is set");
	expect(await page.content()).not.toContain(token);
	expect(await page.content()).not.toContain("teacher01");

	await card.getByRole("button", { name: "Remove account…" }).click();
	const dialog = page.getByTestId("docker-hub-remove-dialog");
	await dialog.getByRole("button", { name: "Remove account" }).click();
	expect(await takeRegistryRequest()).toEqual({ kind: "remove-hub-credential" });
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Docker Hub account", exact: true }),
	).toBeFocused();
});

test("the ghcr.io switch is on by default, says what breaks, and round-trips", async ({
	page,
}) => {
	// The other tests start with it off; this one takes the column's default.
	await query("update settings set docker_ghcr_enabled = default where id = 1");
	await writeRegistryStatus({ ghcrEnabled: true, ghcrUp: true });
	await open(page);
	const toggle = page.getByRole("switch", { name: "Cache ghcr.io images" });
	await expect(toggle).toBeChecked();
	await expect(page.locator("#docker-ghcr-warning")).toHaveText(
		"While on, workspaces cannot push to ghcr.io.",
	);
	await expect(toggle).toHaveAccessibleDescription(
		"While on, workspaces cannot push to ghcr.io.",
	);
	const about = page.getByRole("button", { name: "About the ghcr.io cache" });
	await about.click();
	const tip = openToggletip(page);
	await expect(tip).toContainText("cannot pull private ghcr.io images");
	await expect(tip).toContainText("tools other than Docker");
	await expect(tip).toContainText(
		"Turning it off reaches a running workspace only when it next starts",
	);
	await expect(tip).toContainText(
		"Build and push images from GitHub Actions; pull them here.",
	);
	await page.keyboard.press("Escape");
	await expect(about).toBeFocused();

	await toggle.click();
	expect(await takeRegistryRequest()).toEqual({ kind: "set-ghcr", enabled: false });
	await expect(toggle).not.toBeChecked();
	// The switch moves at once; the seed form sees the change only once the save settles.
	await expect(toggle).not.toHaveAttribute("aria-disabled");
	await writeRegistryStatus();

	// A ghcr.io name is refused while the cache is off.
	const add = page.getByTestId("docker-seed").getByLabel("Image", { exact: true });
	await add.fill("ghcr.io/owner/tool:1");
	await page.getByRole("button", { name: "Add image" }).click();
	await expect(
		page.getByText("Turn on the ghcr.io cache before seeding ghcr.io images."),
	).toBeVisible();

	await toggle.click();
	expect(await takeRegistryRequest()).toEqual({ kind: "set-ghcr", enabled: true });
	await expect(toggle).toBeChecked();
	await expect(page.getByTestId("docker-ghcr-waiting")).toBeVisible();
	const [row] = await query<{ on: boolean }>(
		"select docker_ghcr_enabled as on from settings where id = 1",
	);
	expect(row?.on).toBe(true);

	await writeRegistryStatus({ ghcrEnabled: true, ghcrUp: true });
	await page.reload();
	await expect(page.getByTestId("docker-ghcr-waiting")).toHaveCount(0);
	await add.fill("ghcr.io/owner/tool:1");
	await page.getByRole("button", { name: "Add image" }).click();
	await expect(page.getByTestId("docker-seed-list")).toContainText(
		"ghcr.io/owner/tool:1",
	);

	// Off again: the saved ghcr.io name now blocks a rebuild until it is removed.
	await toggle.click();
	expect(await takeRegistryRequest()).toEqual({ kind: "set-ghcr", enabled: false });
	await expect(page.getByTestId("docker-seed-list-error")).toContainText(
		"Turn on the ghcr.io cache before seeding ghcr.io images.",
	);
	await expect(page.getByTestId("docker-seed-rebuild")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await page.getByRole("button", { name: "Remove ghcr.io/owner/tool:1" }).click();
	await expect(page.getByTestId("docker-seed-list-error")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Images for the next rebuild" }),
	).toBeFocused();
});

test("image use lists outside and unused images, with add and remove", async ({
	page,
}) => {
	await writeRegistryStatus();
	const one = await makeWorkspace();
	const two = await makeWorkspace();
	await setSeedList(["python:3.12", "node:22"]);
	await putSeed(["python:3.12", "node:22"]);
	for (const [ws, pulls] of [
		[one, 3],
		[two, 1],
	] as const) {
		await query(
			"insert into docker_image_pulls (image, workspace_id, day, pulls) values ('docker.io/library/redis:7', $1, current_date, $2)",
			[ws, pulls],
		);
	}
	await query(
		`insert into docker_image_presence (workspace_id, image, in_seed, used) values
		 ($1, 'docker.io/library/python:3.12', true, true),
		 ($1, 'docker.io/library/node:22', true, false)`,
		[one],
	);
	await open(page);

	const extra = page.getByTestId("docker-usage-extra");
	const redis = extra.getByRole("row", { name: /redis:7/ });
	// Download size, pulls, workspaces.
	await expect(redis.getByRole("cell").nth(1)).toHaveText("4");
	await expect(redis.getByRole("cell").nth(2)).toHaveText("2");
	await redis.getByRole("button", { name: "Add to seed: redis:7" }).click();
	await expect(redis).toContainText("In the next rebuild");
	// The pressed button is gone; focus stays on the table's heading.
	await expect(
		page.getByRole("heading", { name: "Used but not in the seed" }),
	).toBeFocused();
	expect(await seedList()).toEqual(["python:3.12", "node:22", "redis:7"]);

	const unused = page.getByTestId("docker-usage-unused");
	const node = unused.getByRole("row", { name: /node:22/ });
	await expect(node.getByRole("cell").nth(1)).toHaveText("1");
	await node.getByRole("button", { name: "Remove from seed: node:22" }).click();
	await expect(node).toContainText("Not in the next rebuild");
	await expect(
		page.getByRole("heading", { name: "Seed images nobody used" }),
	).toBeFocused();
	expect(await seedList()).toEqual(["python:3.12", "redis:7"]);
	await expect(page.getByTestId("docker-usage")).not.toContainText("python:3.12");
});

test("a capped usage table says how many it shows, and a saved ghcr.io name is blamed", async ({
	page,
}) => {
	await writeRegistryStatus();
	const ws = await makeWorkspace();
	// ghcr.io is off, so the saved ghcr.io name blocks every Add to seed.
	await setSeedList(["python:3.12", "ghcr.io/owner/tool:1"]);
	await query(
		`insert into docker_image_pulls (image, workspace_id, day, pulls)
		 select 'docker.io/library/img' || n || ':1', $1, current_date, 1
		 from generate_series(1, 205) as n`,
		[ws],
	);
	await open(page);
	await expect(page.getByTestId("docker-usage-extra-shown")).toHaveText(
		"Showing 200 of 205.",
	);
	await expect(page.getByTestId("docker-usage-extra").getByRole("row")).toHaveCount(
		201,
	);
	await expect(page.getByTestId("docker-usage-unused-shown")).toHaveCount(0);
	await expect(
		page
			.getByTestId("docker-usage-extra")
			.getByText(
				"The seed list has ghcr.io images; turn on the ghcr.io cache or remove them first.",
			)
			.first(),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /^Add to seed/ })).toHaveCount(0);
});

test("a failed clear shows, and a stopped Hub cache says it waits for a clear", async ({
	page,
}) => {
	await writeRegistryStatus({
		hubUp: false,
		hubCredentialSet: true,
		lastClearError: "the cache volume is busy",
	});
	await open(page);
	await expect(page.getByTestId("docker-cache-clear-error")).toHaveText(
		"The last clear failed: the cache volume is busy The Docker Hub cache stays stopped until Clear cache succeeds.",
	);
	await writeRegistryStatus();
	await page.reload();
	await expect(page.getByTestId("docker-cache")).toBeVisible();
	await expect(page.getByTestId("docker-cache-clear-error")).toHaveCount(0);
});

test("the tab says it is off when the server has no cache", async ({ page }) => {
	await routeApi(page, "**/admin/docker", (route) =>
		route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Not found." } }),
	);
	await loginAs(page, "carol");
	await page.goto("/admin/docker");
	await expect(page.getByTestId("docker-off")).toContainText(
		"The Docker cache is off on this site",
	);
});

const MB = 1024 ** 2;
const SEEN = new Date().toISOString();
/** Download sizes as the helper records them; node:22 was never in the cache. */
const SIZES = {
	"docker.io/library/python:3.12": { bytes: 60 * MB, seenAt: SEEN },
	"docker.io/library/redis:7": { bytes: 40 * MB, seenAt: SEEN },
};
const OFF_REASON =
	"When setup last ran, the main disk had 9.5 GiB free, and setup keeps 10 GiB of it free, so not even a 1 GiB cache fits.";

/** A seed, a list one image longer, and one workspace that pulled redis:7 and left node:22 unused. */
async function sizedTab() {
	await writeRegistryStatus({ imageSizes: SIZES });
	const ws = await makeWorkspace();
	await setSeedList(["python:3.12", "node:22", "redis:7"]);
	await putSeed(["python:3.12", "node:22"]);
	await query(
		"insert into docker_image_pulls (image, workspace_id, day, pulls) values ('docker.io/library/redis:7', $1, current_date, 2), ('docker.io/library/mysql:8', $1, current_date, 1)",
		[ws],
	);
	await query(
		"insert into docker_image_presence (workspace_id, image, in_seed, used) values ($1, 'docker.io/library/node:22', true, false)",
		[ws],
	);
}

test("every image row shows its download size or a dash, and the report covers 120 days", async ({
	page,
}) => {
	await sizedTab();
	await open(page);
	const size = (table: string, image: RegExp) =>
		page.getByTestId(table).getByRole("row", { name: image }).getByRole("cell").first();

	await expect(size("docker-seed-images", /python:3\.12/)).toHaveText("60.0 MB");
	await expect(size("docker-seed-images", /node:22/)).toHaveText("—Not known");
	await expect(size("docker-seed-list", /redis:7/)).toHaveText("40.0 MB");
	await expect(size("docker-seed-list", /node:22/)).toHaveText("—Not known");
	await expect(page.getByTestId("docker-seed-list-size")).toHaveText(
		"These images download as 100 MB, not counting 1 image the pull cache has not held. The limit of 8.0 GB counts the unpacked images, which take more space than their download.",
	);
	// An image added before a rebuild shows its size straight away.
	await page
		.getByTestId("docker-seed")
		.getByLabel("Image", { exact: true })
		.fill("mysql:8");
	await page.getByRole("button", { name: "Add image" }).click();
	await expect(size("docker-seed-list", /mysql:8/)).toHaveText("—Not known");

	await expect(size("docker-usage-extra", /mysql:8/)).toHaveText("—Not known");
	await expect(size("docker-usage-unused", /node:22/)).toHaveText("—Not known");
	await expect(page.getByTestId("docker-usage-window")).toContainText(
		"Over the last 120 days.",
	);
});

test("the cache and seed meters show their fill, the 90 percent mark, and follow changes", async ({
	page,
}) => {
	await writeRegistryStatus({ usedBytes: 5 * 1024 ** 3 });
	await setSeedList(["python:3.12"]);
	await putSeed(["python:3.12"]);
	await open(page);
	const cache = page.getByRole("meter", { name: "Pull cache space" });
	await expect(cache).toHaveJSProperty("value", 5 * 1024 ** 3);
	await expect(cache).toHaveJSProperty("max", 20 * 1024 ** 3);
	const space = page.getByTestId("docker-cache-space");
	await expect(space).toContainText("5.0 GB of 20.0 GB used");
	await expect(space).toContainText("The line marks 90 percent");
	// The tick sits nine tenths along the bar.
	const bar = await cache.boundingBox();
	const tick = await space.locator(".pk-meter-mark").boundingBox();
	expect(bar && tick).toBeTruthy();
	if (bar && tick) {
		const at = (tick.x + tick.width / 2 - bar.x) / bar.width;
		expect(at).toBeGreaterThan(0.88);
		expect(at).toBeLessThan(0.92);
	}
	const seed = page.getByRole("meter", { name: "Seed size" });
	await expect(seed).toHaveJSProperty("value", 2 * 1024 ** 3);
	await expect(seed).toHaveJSProperty("max", 8 * 1024 ** 3);
	await expect(page.getByTestId("docker-seed-size")).toHaveText(
		"2.0 GB of the 8.0 GB limit",
	);
	// Each meter's name is its row label, so what is read matches what is seen.
	await expect(
		page.getByRole("term").filter({ hasText: /^Pull cache space$/ }),
	).toBeVisible();
	await expect(page.getByRole("term").filter({ hasText: /^Seed size$/ })).toBeVisible();
	await expect(seed).not.toHaveAttribute("aria-valuetext", /nearly full/);

	await writeRegistryStatus({ usedBytes: 12 * 1024 ** 3 });
	await query("update settings set docker_seed_max_gib = 4 where id = 1");
	await page.reload();
	await expect(cache).toHaveJSProperty("value", 12 * 1024 ** 3);
	await expect(seed).toHaveJSProperty("max", 4 * 1024 ** 3);
	await expect(page.getByTestId("docker-seed-size")).toHaveText(
		"2.0 GB of the 4.0 GB limit",
	);
});

test("when setup turned the cache off, the tab says why and Clear cache claims nothing", async ({
	page,
}) => {
	await writeRegistryStatus({
		cacheOff: OFF_REASON,
		sizeBytes: 0,
		usedBytes: 0,
		hubUp: false,
	});
	await open(page);
	const line = page.getByTestId("docker-cache-off");
	await expect(line).toContainText("Setup turned the pull cache off");
	await expect(line).toContainText(OFF_REASON);
	await expect(line).toContainText("sudo dpkg-reconfigure portikus");
	await expect(page.getByRole("meter", { name: "Pull cache space" })).toHaveCount(0);
	await expect(page.getByTestId("docker-ghcr-state")).toHaveText(
		"The pull cache is off, so workspaces reach ghcr.io directly.",
	);

	const clear = page.getByRole("button", { name: "Clear cache…" });
	await expect(clear).toHaveAttribute("aria-disabled", "true");
	await expect(clear).toHaveAccessibleDescription(/Setup turned the pull cache off/);
	// Still focusable (SPEC.md 25.8), so a keyboard press must do nothing.
	await clear.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("docker-cache-clear-dialog")).toHaveCount(0);
	expect(await registryRequests()).toEqual([]);

	// A stale page that still sends a clear is refused, with nothing written.
	const res = await page.request.post("/admin/docker/cache/clear", {
		headers: { origin: WEB_ORIGIN },
	});
	expect(res.status()).toBe(404);
	expect(await registryRequests()).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Docker tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await writeRegistryStatus({
			hubCredentialSet: true,
			ghcrEnabled: false,
			lastClearedAt: "2026-09-29T10:00:00.000Z",
			lastClearReason: "admin",
			imageSizes: SIZES,
		});
		const ws = await makeWorkspace();
		await setSeedList(["python:3.12", "node:22", "ghcr.io/owner/tool:1"]);
		await putSeed(["python:3.12", "node:22"]);
		await query(
			`insert into docker_seed_jobs (state, step, images) values
			 ('running', 'Pulling node:22 (2 of 2)', '["python:3.12","node:22"]')`,
		);
		await query(
			"insert into docker_image_pulls (image, workspace_id, day, pulls) values ('docker.io/library/redis:7', $1, current_date, 2), ('ghcr.io/owner/other:1', $1, current_date, 1)",
			[ws],
		);
		await query(
			"insert into docker_image_presence (workspace_id, image, in_seed, used) values ($1, 'docker.io/library/node:22', true, false)",
			[ws],
		);
		await page.emulateMedia({ colorScheme });
		await open(page);
		await expect(page.getByTestId("docker-seed-job-state")).toContainText("Pulling");
		await expect(page.getByTestId("docker-usage-extra")).toBeVisible();
		await expect(page.getByTestId("docker-seed-list-error")).toBeVisible();
		await expect(page.getByRole("meter", { name: "Pull cache space" })).toBeVisible();
		await expect(page.getByRole("meter", { name: "Seed size" })).toBeVisible();
		await expect(page.getByTestId("docker-seed-images")).toContainText("60.0 MB");
		await expectNoViolations(page);

		const tip = page.getByRole("button", { name: "About the seed" });
		await tip.click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(tip).toBeFocused();

		await page.getByRole("button", { name: "Clear cache…" }).click();
		await expect(page.getByTestId("docker-cache-clear-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("docker-cache-clear-dialog")).toHaveCount(0);

		// A cancelled removal returns focus to the button that opened it.
		const removeAccount = page.getByRole("button", { name: "Remove account…" });
		await removeAccount.click();
		await expect(page.getByTestId("docker-hub-remove-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("docker-hub-remove-dialog")).toHaveCount(0);
		await expect(removeAccount).toBeFocused();

		// Field errors: an empty account and an empty seed image.
		const hub = page.getByTestId("docker-hub");
		await hub.getByRole("button", { name: "Replace account" }).click();
		await expect(hub.getByLabel("Docker Hub username")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		await page.getByRole("button", { name: "Add image" }).click();
		await expect(
			page
				.getByTestId("docker-seed")
				.getByText("Enter an image name, such as python:3.12."),
		).toBeVisible();
		await expectNoViolations(page);
		expect(await registryRequests()).toEqual([]);
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`an empty Docker tab says so in one line per card, and has no accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await writeRegistryStatus();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.emulateMedia({ colorScheme });
		await open(page);
		const seed = page.getByTestId("docker-seed");
		await expect(page.getByTestId("docker-seed-none")).toHaveText(
			"No seed yet, so new Docker storage starts empty.",
		);
		await expect(
			seed.getByRole("heading", { level: 4, name: "Current seed" }),
		).toHaveCount(0);
		await expect(
			seed.getByRole("heading", { level: 4, name: "Latest rebuild" }),
		).toHaveCount(0);
		await expect(page.getByTestId("docker-usage-none")).toHaveText(
			"No images used in the last 120 days.",
		);
		await expect(
			page.getByTestId("docker-usage").getByRole("heading", { level: 4 }),
		).toHaveCount(0);

		// Wide enough for two columns: the pull cache over ghcr.io, the account beside
		// them, so no grid cell is left empty.
		const cache = await page.getByTestId("docker-cache").boundingBox();
		const ghcr = await page.getByTestId("docker-ghcr").boundingBox();
		const hub = await page.getByTestId("docker-hub").boundingBox();
		expect(ghcr?.x).toBe(cache?.x);
		expect(ghcr?.y).toBeGreaterThan((cache?.y ?? 0) + (cache?.height ?? 0));
		expect(hub?.y).toBe(cache?.y);
		expect(hub?.x).toBeGreaterThan((cache?.x ?? 0) + (cache?.width ?? 0));
		// Nothing in the grid sits below the left stack's last card.
		const grid = await page.getByTestId("docker-settings").boundingBox();
		const bottom = (box: typeof grid) => (box?.y ?? 0) + (box?.height ?? 0);
		expect(bottom(grid)).toBe(Math.max(bottom(ghcr), bottom(hub)));

		// The Docker Hub warning stays in the form's column.
		const form = await page
			.getByRole("form", { name: "Docker Hub account" })
			.boundingBox();
		const warning = await page.getByTestId("docker-hub-warning").boundingBox();
		expect(warning?.width).toBeLessThanOrEqual(form?.width ?? 0);
		await expectNoViolations(page);

		const tip = page.getByRole("button", { name: "About the ghcr.io cache" });
		await tip.click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(tip).toBeFocused();
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the cache-off line and a nearly full seed have no accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await writeRegistryStatus({
			cacheOff: OFF_REASON,
			sizeBytes: 0,
			usedBytes: 0,
			hubUp: false,
		});
		await setSeedList(["python:3.12"]);
		// Past the warning share of a 1 GiB limit, so the warning fill is checked too.
		await query("update settings set docker_seed_max_gib = 1 where id = 1");
		await query(
			`insert into docker_seed (id, images, size_bytes, image_version, built_at)
			 values (1, '["python:3.12"]', $1, '2026.09.9', now())`,
			[Math.round(0.95 * 1024 ** 3)],
		);
		await page.emulateMedia({ colorScheme });
		await open(page);
		await expect(page.getByTestId("docker-cache-off")).toBeVisible();
		const seed = page.getByRole("meter", { name: "Seed size" });
		await expect(seed).toBeVisible();
		// Past the warning share it says so in words and with the alert icon, not by colour alone.
		await expect(seed).toHaveAttribute("aria-valuetext", /, nearly full$/);
		const size = page.getByTestId("docker-seed-size");
		await expect(size).toContainText("nearly full");
		await expect(size.locator('[data-icon="alert"]')).toBeVisible();
		await expectNoViolations(page);
	});
}
