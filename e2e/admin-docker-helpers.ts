import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { FAKE_AGENT_TOKEN, loginAs, MOCK_ISSUER, query } from "./helpers";
import { resetRegistryJobs } from "./registry-jobs";

/**
 * Shared by the Docker tab's spec files. The tests play the root cache
 * helper (its request files and status.json) and the worker (the seed job
 * rows and the usage tables) by hand against the real API.
 */

/**
 * Every Docker spec file calls this once: each test starts from a clean slate.
 * The files share one settings row, the seed tables and the helper directory;
 * the "docker" project in playwright.config.ts runs them on one worker.
 */
export function useDockerState(): void {
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
}

export async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/docker");
	await expect(
		page.getByRole("heading", { level: 2, name: "Docker", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("docker-cache")).toBeVisible();
}

export async function seedList(): Promise<string[]> {
	const [row] = await query<{ images: string[] }>(
		"select docker_seed_images as images from settings where id = 1",
	);
	return row?.images ?? [];
}

export async function setSeedList(images: string[]) {
	await query("update settings set docker_seed_images = $1 where id = 1", [
		JSON.stringify(images),
	]);
}

export async function putSeed(images: string[], imageVersion = "2026.09.9") {
	await query(
		`insert into docker_seed (id, images, size_bytes, image_version, built_at)
		 values (1, $1, $2, $3, now())`,
		[JSON.stringify(images), 2 * 1024 ** 3, imageVersion],
	);
}

/** A stopped workspace for the usage tables, which count workspaces only. */
export async function makeWorkspace(): Promise<string> {
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
