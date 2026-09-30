import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	FAKE_AGENT_TOKEN,
	loginAs,
	MOCK_ISSUER,
	openToggletip,
	query,
	settledAxe,
	WCAG_TAGS,
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
		 docker_seed_images = '[]' where id = 1`,
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
	await expect(page.getByTestId("docker-cache-use")).toHaveText(
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

test("the ghcr.io switch is off by default, says what breaks, and round-trips", async ({
	page,
}) => {
	await writeRegistryStatus();
	await open(page);
	const toggle = page.getByRole("switch", { name: "Cache ghcr.io images" });
	await expect(toggle).not.toBeChecked();
	const warning = page.locator("#docker-ghcr-warning");
	await expect(warning).toContainText("cannot docker push to ghcr.io");
	await expect(warning).toContainText("cannot pull private ghcr.io images");
	await expect(warning).toContainText("tools other than Docker");
	await expect(warning).toContainText(
		"Turning it off reaches a running workspace only when it next starts",
	);

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
	await expect(page.getByTestId("docker-seed-size")).toHaveText("2.0 GB");
	await expect(page.getByTestId("docker-seed-image-version")).toHaveText("2026.09.12");
	await expect(page.getByTestId("docker-seed-images")).toHaveText(
		/python:3\.12\s*node:22/,
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
	await expect(redis.getByRole("cell").nth(0)).toHaveText("4");
	await expect(redis.getByRole("cell").nth(1)).toHaveText("2");
	await redis.getByRole("button", { name: "Add to seed: redis:7" }).click();
	await expect(redis).toContainText("In the next rebuild");
	// The pressed button is gone; focus stays on the table's heading.
	await expect(
		page.getByRole("heading", { name: "Used but not in the seed" }),
	).toBeFocused();
	expect(await seedList()).toEqual(["python:3.12", "node:22", "redis:7"]);

	const unused = page.getByTestId("docker-usage-unused");
	const node = unused.getByRole("row", { name: /node:22/ });
	await expect(node.getByRole("cell").nth(0)).toHaveText("1");
	await node.getByRole("button", { name: "Remove from seed: node:22" }).click();
	await expect(node).toContainText("Not in the next rebuild");
	await expect(
		page.getByRole("heading", { name: "Seed images nobody used" }),
	).toBeFocused();
	expect(await seedList()).toEqual(["python:3.12", "redis:7"]);
	await expect(page.getByTestId("docker-usage")).not.toContainText("python:3.12");
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
