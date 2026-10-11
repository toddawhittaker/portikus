import { expect, test } from "@playwright/test";
import { open, setSeedList, useDockerState } from "./admin-docker-helpers";
import { query } from "./helpers";
import { writeRegistryStatus } from "./registry-jobs";

/**
 * Seed image sizes on the Docker tab: unpacked on disk as the seed build
 * measured them, keyed so a digest-pinned name finds its size (SPEC.md
 * section 16.6).
 */

useDockerState();

const PINNED = `python:3.12@sha256:${"a".repeat(64)}`;

test("a digest-pinned seed image shows the unpacked size its build measured", async ({
	page,
}) => {
	await writeRegistryStatus({
		imageSizes: {
			"docker.io/library/redis:7": {
				bytes: 40 * 1024 ** 2,
				seenAt: new Date().toISOString(),
			},
		},
	});
	await setSeedList([PINNED, "redis:7"]);
	// The worker writes the seed row as the controller's build reported it.
	await query(
		`insert into docker_seed (id, images, size_bytes, image_version, built_at, image_bytes)
		 values (1, $1, $2, '2026.09.9', now(), $3)`,
		[
			JSON.stringify([PINNED]),
			1024 ** 3,
			JSON.stringify({ [`docker.io/library/${PINNED}`]: 150 * 1024 ** 2 }),
		],
	);
	await open(page);
	const size = (table: string, image: RegExp) =>
		page.getByTestId(table).getByRole("row", { name: image }).getByRole("cell").first();

	await expect(size("docker-seed-images", /python:3\.12@sha256/)).toHaveText(
		"150 MB on disk",
	);
	await expect(size("docker-seed-list", /python:3\.12@sha256/)).toHaveText(
		"150 MB on disk",
	);
	await expect(size("docker-seed-list", /redis:7/)).toHaveText("40.0 MB download");
	await expect(page.getByTestId("docker-seed-list-size")).toHaveText(
		"These images take at least 190 MB, counting download sizes for the 1 not in the last seed. The limit of 8.0 GB counts the unpacked images, which take more space than their download.",
	);
});
