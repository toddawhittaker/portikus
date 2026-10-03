import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	open,
	putSeed,
	seedList,
	setSeedList,
	useDockerState,
} from "./admin-docker-helpers";
import { expectNoViolations, query, routeApi, toast } from "./helpers";
import { registryRequests, writeRegistryStatus } from "./registry-jobs";

/** The Docker tab's seed: its image list, size limit, rebuilds and the drift notice. */

useDockerState();

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
	const none = page.getByTestId("docker-seed-none");
	await expect(none).toHaveText("No seed yet, so new Docker storage starts empty.");
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
	// The last step ("Done") would only repeat the state.
	await expect(state).toHaveText("Finished");
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

test("Rebuild seed's reason for being off sits under it and stays its description", async ({
	page,
}) => {
	await writeRegistryStatus();
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page);
	const button = page.getByTestId("docker-seed-rebuild");
	const reason = "Add at least one image before rebuilding the seed.";
	await expect(button).toHaveAccessibleDescription(reason);
	const note = await page.locator("#docker-seed-rebuild-note").boundingBox();
	const box = await button.boundingBox();
	expect(note?.y).toBeGreaterThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
	// End-aligned with the button, as on the Certificate tab.
	expect(
		Math.abs((note?.x ?? 0) + (note?.width ?? 0) - ((box?.x ?? 0) + (box?.width ?? 0))),
	).toBeLessThanOrEqual(1);
	// The card's body is its one empty-seed sentence, below the header.
	const none = await page.getByTestId("docker-seed-none").boundingBox();
	expect(none?.y).toBeGreaterThan((note?.y ?? 0) + (note?.height ?? 0));
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

/**
 * The drift notice (SPEC.md §16.6). The API reads the default image's
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
	await routeApi(page, "**/admin/docker", async (route) => {
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
	const next = ["redis:7", "node:26-slim", "python:3.14-slim"];
	// The list is swapped before the reply, so the page's reread drops the
	// notice before the mutation settles; the toast and focus must survive that.
	await page.route("**/admin/docker/seed/match", async (route) => {
		posted += 1;
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
	expect(posted).toBe(1);
	// Focus waits on the heading of the list it changed.
	await expect(page.locator("#docker-seed-list-title")).toBeFocused();
	// A list that holds the new images has no notice.
	await expect(notice).toHaveCount(0);
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
