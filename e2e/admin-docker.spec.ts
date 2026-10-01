import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	FAKE_AGENT_TOKEN,
	loginAs,
	MOCK_ISSUER,
	openToggletip,
	query,
	settledAxe,
	toast,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";
import {
	registryRequests,
	resetRegistryJobs,
	takeRegistryRequest,
	writeRegistryStatus,
} from "./registry-jobs";

/**
 * The Docker tab (issue #840) against the real API. The tests play the root
 * cache helper (its request files and status.json) and the worker (the seed
 * job rows and the usage tables) by hand.
 */

// One helper directory and one set of Docker settings for the whole file.
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
	await resetRegistryJobs();
	await query(
		"insert into settings (id, shutdown_grace_seconds) values (1, 600) on conflict do nothing",
	);
	await query(
		`update settings set docker_ghcr_enabled = false, docker_seed_max_gib = 8,
		 docker_seed_images = '[]', docker_seed_images_set = true where id = 1`,
	);
	await query("delete from docker_seed_jobs");
	await query("delete from docker_seed");
	await query("delete from docker_image_pulls");
	await query("delete from docker_image_presence");
});

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=docker");
	await expect(
		page.getByRole("heading", { level: 2, name: "Docker", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("docker-cache")).toBeVisible();
}

async function seedList(): Promise<string[]> {
	const [row] = await query<{ images: string[] }>(
		"select docker_seed_images as images from settings where id = 1",
	);
	return row?.images ?? [];
}

async function setSeedList(images: string[]) {
	await query("update settings set docker_seed_images = $1 where id = 1", [
		JSON.stringify(images),
	]);
}

async function putSeed(images: string[], imageVersion = "2026.09.9") {
	await query(
		`insert into docker_seed (id, images, size_bytes, image_version, built_at)
		 values (1, $1, $2, $3, now())`,
		[JSON.stringify(images), 2 * 1024 ** 3, imageVersion],
	);
}

/** A stopped workspace for the usage tables, which count workspaces only. */
async function makeWorkspace(): Promise<string> {
	const subject = `e2e-${randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, 'E2E Docker', 'student') returning id`,
		[MOCK_ISSUER, subject, `${subject}@example.edu`],
	);
	const id = randomUUID();
	const short = id.replace(/-/g, "");
	await query(
		`insert into workspaces
		   (id, owner_user_id, label, incus_instance_name, state, desired_state,
		    agent_address, agent_token)
		 values ($1, $2, $3, $4, 'stopped', 'stopped', '127.0.0.1', $5)`,
		[
			id,
			user?.id,
			`ws-${short.slice(0, 8)}`,
			`ws-${short.slice(0, 24)}`,
			`${FAKE_AGENT_TOKEN}:${id}`,
		],
	);
	return id;
}

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
	const warning = page.locator("#docker-ghcr-warning");
	await expect(warning).toContainText("cannot docker push to ghcr.io");
	await expect(warning).toContainText("cannot pull private ghcr.io images");
	await expect(warning).toContainText("tools other than Docker");
	await expect(warning).toContainText(
		"Turning it off reaches a running workspace only when it next starts",
	);
	await expect(warning).toContainText(
		"Build and push images from GitHub Actions; pull them here.",
	);

	await toggle.click();
	expect(await takeRegistryRequest()).toEqual({ kind: "set-ghcr", enabled: false });
	await expect(toggle).not.toBeChecked();
	await writeRegistryStatus();

	// A ghcr.io name is refused while the cache is off (ruling S8).
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

test("the seed list takes only names the contract allows, and the size limit saves", async ({
	page,
}) => {
	await writeRegistryStatus();
	await open(page);
	await expect(page.getByTestId("docker-seed-none")).toBeVisible();
	await expect(page.getByTestId("docker-seed-rebuild")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	const seed = page.getByTestId("docker-seed");
	const add = seed.getByLabel("Image", { exact: true });
	const submit = seed.getByRole("button", { name: "Add image" });

	for (const [name, message] of [
		["", "Enter an image name, such as python:3.12."],
		[
			"Python:3.12",
			"Must be an image name such as python:3.12 or ghcr.io/owner/name:tag.",
		],
		["quay.io/owner/name:1", "Only Docker Hub and ghcr.io images may be seeded."],
		[
			"localhost:5000/name",
			"Must be an image name such as python:3.12 or ghcr.io/owner/name:tag.",
		],
	] as const) {
		await add.fill(name);
		await submit.click();
		await expect(seed.getByRole("alert")).toHaveText(message);
	}
	expect(await seedList()).toEqual([]);

	await add.fill("python:3.12");
	await submit.click();
	await expect(page.getByTestId("docker-seed-list")).toContainText("python:3.12");
	await expect(add).toHaveValue("");
	await add.fill("docker.io/library/python:3.12");
	await submit.click();
	await expect(seed.getByRole("alert")).toHaveText("Each image may appear once.");
	await add.fill("node:22");
	await submit.click();
	await expect(page.getByTestId("docker-seed-list-count")).toHaveText("2 of 30");
	expect(await seedList()).toEqual(["python:3.12", "node:22"]);

	await page.getByRole("button", { name: "Remove python:3.12" }).click();
	await expect(page.getByTestId("docker-seed-list-count")).toHaveText("1 of 30");
	expect(await seedList()).toEqual(["node:22"]);

	const limit = seed.getByLabel("Largest seed (GiB)");
	await expect(limit).toHaveValue("8");
	await limit.fill("65");
	await seed.getByRole("button", { name: "Save limit" }).click();
	await expect(seed.getByText("Enter a whole number from 1 to 64.")).toBeVisible();
	await limit.fill("12");
	await seed.getByRole("button", { name: "Save limit" }).click();
	await expect(seed.getByText("Enter a whole number from 1 to 64.")).toHaveCount(0);
	await expect
		.poll(async () => {
			const [row] = await query<{ gib: number }>(
				"select docker_seed_max_gib as gib from settings where id = 1",
			);
			return row?.gib;
		})
		.toBe(12);
	// The limit is saved without touching the ghcr.io switch.
	expect(await registryRequests()).toEqual([]);
});

test("Rebuild seed shows its progress, then the new seed", async ({ page }) => {
	await writeRegistryStatus();
	await setSeedList(["python:3.12", "node:22"]);
	await open(page);
	// The status region is there before the first job, so its arrival is announced.
	const none = page.getByTestId("docker-seed-job-none");
	await expect(none).toHaveText("The seed has not been rebuilt yet.");
	const region = await page
		.getByTestId("docker-seed")
		.getByRole("status")
		.filter({ has: none })
		.elementHandle();
	await page.getByRole("button", { name: "Rebuild seed" }).click();
	const state = page.getByTestId("docker-seed-job-state");
	await expect(state).toBeVisible();
	expect(
		await region?.evaluate((el) =>
			el.contains(document.querySelector('[data-testid="docker-seed-job-state"]')),
		),
	).toBe(true);
	await expect(state).toContainText("Waiting to start");
	await expect(page.getByTestId("docker-seed-rebuild")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	const [job] = await query<{ id: string }>("select id from docker_seed_jobs");
	expect(job).toBeDefined();

	await query(
		"update docker_seed_jobs set state = 'running', step = 'Pulling node:22 (2 of 2)' where id = $1",
		[job?.id],
	);
	await expect(state).toContainText("Pulling node:22 (2 of 2)");

	await putSeed(["python:3.12", "node:22"], "2026.09.12");
	await query(
		"update docker_seed_jobs set state = 'succeeded', step = 'Done', finished_at = now() where id = $1",
		[job?.id],
	);
	await expect(state).toContainText("Finished");
	await expect(page.getByTestId("docker-seed-size")).toHaveText(
		"2.0 GB of the 8.0 GB limit",
	);
	await expect(page.getByTestId("docker-seed-image-version")).toHaveText("2026.09.12");
	await expect(page.getByTestId("docker-seed-images")).toContainText(
		/python:3\.12.*node:22/,
	);
	await expect(page.getByTestId("docker-seed-rebuild")).not.toHaveAttribute(
		"aria-disabled",
		"true",
	);
});

test("a failed rebuild shows its reason", async ({ page }) => {
	await writeRegistryStatus();
	await setSeedList(["python:3.12"]);
	await query(
		`insert into docker_seed_jobs (state, step, images, message, finished_at)
		 values ('failed', 'Measuring the seed', '["python:3.12"]',
		         'The seed would be 9.2 GiB, over the 8 GiB limit.', now())`,
	);
	await open(page);
	await expect(page.getByTestId("docker-seed-job-state")).toContainText("Failed");
	await expect(page.getByTestId("docker-seed-job-message")).toHaveText(
		"The seed would be 9.2 GiB, over the 8 GiB limit.",
	);
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
	await page.route("**/admin/docker", (route) =>
		route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Not found." } }),
	);
	await loginAs(page, "carol");
	await page.goto("/admin?tab=docker");
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

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

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

/**
 * The drift notice (issue #932, ruling R4). The API reads the default image's
 * manifest from the image store, which admin-image.spec.ts resets while this
 * file runs, so these tests add the image's match to the real answer in the
 * browser. The API tests cover reading the manifest, the default list and the
 * button's route against the database.
 */
const MATCH_26_314 = {
	node: { version: "26", image: "node:26-slim" },
	python: { version: "3.14", image: "python:3.14-slim" },
};

async function withMatch(page: Page) {
	await page.route("**/admin/docker", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({ response, json: { ...body, match: MATCH_26_314 } });
	});
}

test("the drift notice's button asks the API to swap the images and rebuild", async ({
	page,
}) => {
	await setSeedList(["node:24-slim", "redis:7", "python:3.13-slim"]);
	await withMatch(page);
	let posted = 0;
	await page.route("**/admin/docker/seed/match", async (route) => {
		posted += 1;
		const next = ["redis:7", "node:26-slim", "python:3.14-slim"];
		await setSeedList(next);
		await route.fulfill({
			status: 202,
			json: {
				id: randomUUID(),
				state: "queued",
				step: "Waiting to start",
				images: next,
				message: null,
				requestedAt: new Date().toISOString(),
				finishedAt: null,
			},
		});
	});
	await open(page);
	const notice = page.getByTestId("docker-seed-drift");
	await expect(notice).toContainText(
		"The default workspace image runs Node 26 and Python 3.14, but the seed list has node:24-slim and python:3.13-slim.",
	);
	// It sits under the heading of the list it changes.
	await expect(
		page
			.getByRole("region", { name: /Images for the next rebuild/ })
			.getByTestId("docker-seed-drift"),
	).toBeVisible();
	await notice.getByRole("button", { name: "Update list and rebuild" }).click();
	await expect(toast(page, "Seed list updated, rebuild requested")).toBeVisible();
	// The list reread holds the new images, so the notice goes.
	await expect(notice).toHaveCount(0);
	expect(posted).toBe(1);
	// Its button went with it; focus waits on the heading of the list it changed.
	await expect(page.locator("#docker-seed-list-title")).toBeFocused();
});

test("over the size limit the drift notice says so and offers no button", async ({
	page,
}) => {
	await query("update settings set docker_seed_max_gib = 1 where id = 1");
	await setSeedList(["redis:7"]);
	await writeRegistryStatus({
		imageSizes: {
			"docker.io/library/redis:7": {
				bytes: 1024 ** 3,
				seenAt: new Date().toISOString(),
			},
		},
	});
	await withMatch(page);
	await open(page);
	const notice = page.getByTestId("docker-seed-drift");
	await expect(notice.getByTestId("docker-seed-drift-over")).toContainText(
		"would take the list past the 1.0 GB limit. That is an estimate from download sizes",
	);
	await expect(notice.getByRole("button")).toHaveCount(0);
	expect(await seedList()).toEqual(["redis:7"]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the drift notice has no accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await setSeedList(["node:24-slim", "python:3.13-slim"]);
		await withMatch(page);
		await page.emulateMedia({ colorScheme });
		await open(page);
		await expect(page.getByTestId("docker-seed-drift")).toBeVisible();
		await expectNoViolations(page);
		// The over-limit wording too.
		await query("update settings set docker_seed_max_gib = 1 where id = 1");
		await setSeedList(["node:24-slim", "python:3.13-slim", "redis:7"]);
		await writeRegistryStatus({
			imageSizes: {
				"docker.io/library/redis:7": {
					bytes: 1024 ** 3,
					seenAt: new Date().toISOString(),
				},
			},
		});
		await page.reload();
		await expect(page.getByTestId("docker-seed-drift-over")).toBeVisible();
		await expectNoViolations(page);
	});
}
