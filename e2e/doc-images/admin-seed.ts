/**
 * What the admin shots in admin.capture.ts show: a day of health samples,
 * a week of backups and agent use, an allow-list, the workspace image, the
 * Docker cache and the site's sign-in, written into the run database and the
 * same fake host directories the browser tests use.
 */
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SiteView } from "../../packages/contracts/dist/site.js";
import { backupSet, hostReport, hostStatus, resetBackups } from "../backup-channel";
import { query } from "../helpers";
import {
	IMAGE_JOBS_DIR,
	putCodingAgents,
	putImage,
	resetImageStore,
	setAliases,
	writeLog,
	writeStatus,
} from "../image-jobs";
import { resetRegistryJobs, writeRegistryStatus } from "../registry-jobs";
import { putInstallAnswers, resetSiteStore, SITE_VIEW_FILE } from "../site-jobs";
import type { Person } from "./seed";

const GIB = 1024 ** 3;

/** A day of host samples every minute, as the worker takes them, busiest in the afternoon. */
export async function seedHealth() {
	await query("delete from health_samples");
	for (let minutes = 24 * 60; minutes >= 0; minutes -= 1) {
		const hour = (24 * 60 - minutes) / 60;
		const busy = Math.max(0, Math.sin((hour / 24) * Math.PI * 2 - 1.2));
		await query(
			`insert into health_samples (observed_at, sample)
		 values (now() - make_interval(mins => $1), $2)`,
			[
				minutes,
				JSON.stringify({
					controller: { reachable: true, errorCode: null },
					host: {
						observedAt: new Date().toISOString(),
						loadAverage: [0.6 + busy * 2, 0.5 + busy * 1.8, 0.4 + busy],
						cpuCount: 8,
						memory: {
							usedBytes: Math.round((9 + busy * 12) * GIB),
							totalBytes: 32 * GIB,
						},
						pool: {
							name: "portikus",
							usedBytes: Math.round((182 + hour * 0.6) * GIB),
							totalBytes: 500 * GIB,
							metadataPercent: 9,
						},
						profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
						image: { fingerprint: "a41c9e02d7b85f13ce90", serial: "2026.11.1" },
						instances: [],
						rates: {
							cpuPercent: Math.round(8 + busy * 46),
							netRxBytesPerSecond: Math.round((0.3 + busy * 3) * 1024 * 1024),
							netTxBytesPerSecond: Math.round((0.1 + busy) * 1024 * 1024),
							diskReadBytesPerSecond: Math.round((0.2 + busy) * 1024 * 1024),
							diskWriteBytesPerSecond: Math.round((0.1 + busy * 0.6) * 1024 * 1024),
						},
					},
					// A morning class has just started, matching the six running workspaces seeded.
					runningWorkspaces: minutes <= 90 ? 6 : Math.round(1 + busy * 5),
				}),
			],
		);
	}
}

/** An allow-list with the usual presets and one host a course needs. */
export async function seedNetwork() {
	await query("delete from egress_entries");
	await query(
		`update settings set egress_mode = 'allow-list',
		 egress_presets = '{npm,python,apt,github,claude}', egress_ports = '{22,80,443}',
		 egress_version = egress_version + 1 where id = 1`,
	);
	await query(
		"insert into egress_entries (kind, value, label) values ('host', 'api.open-meteo.com', 'Weather API for CS 1210')",
	);
	await query(
		`update settings set egress_applied_version = egress_version,
		 egress_applied_at = now(), egress_apply_error = null where id = 1`,
	);
}

export const backupDay = (back: number) => {
	const at = new Date(Date.now() - back * 86_400_000);
	at.setUTCHours(7, 30, 0, 0);
	return at;
};
export const backupStamp = (at: Date) =>
	at.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** A week of nightly backup sets of every workspace, the last one this morning. */
export async function seedBackups() {
	await resetBackups();
	const rows = await query<{ incus_instance_name: string }>(
		"select incus_instance_name from workspaces where label not like 'ws-old-%'",
	);
	const instances = rows.map((row) => row.incus_instance_name);
	const last = backupDay(0);
	hostReport(
		hostStatus({
			vm: "portikus",
			lastRun: {
				startedAt: last.toISOString(),
				endedAt: new Date(last.getTime() + 11 * 60_000).toISOString(),
				result: "success",
			},
			nextRunAt: backupDay(-1).toISOString(),
			sets: [0, 1, 2, 3, 4, 5, 6].map((back) =>
				backupSet(backupStamp(backupDay(back)), instances, {
					sizeBytes: Math.round((38 - back * 0.7) * GIB),
				}),
			),
		}),
	);
}

/** An apt install signing in through Google, as the Sign-in and Site address tabs read it. */
export async function seedSite() {
	await resetSiteStore();
	await putInstallAnswers(
		"portikus_admin_email: it-admin@example.edu\nportikus_dex_upstream: google\n" +
			"portikus_public_host: portikus.example.edu\nportikus_storage: file\n" +
			"portikus_storage_size: 500\nportikus_tls: acme\n",
	);
	const view: SiteView = {
		version: 1,
		apt: true,
		host: "portikus.example.edu",
		port: 443,
		previewSuffix: "preview.portikus.example.edu",
		previewSuffixSetByHand: false,
		provider: "google",
		entraTenantId: null,
		googleDomains: ["example.edu"],
		oidcIssuer: null,
		clientId: "123456789012-demo.apps.googleusercontent.com",
		clientSecretSet: true,
		groupsClaim: null,
		groups: {
			student: "portikus-students@example.edu",
			instructor: "portikus-instructors@example.edu",
			admin: "portikus-admins@example.edu",
		},
		certificateSource: "acme",
	};
	await writeFile(SITE_VIEW_FILE, JSON.stringify(view));
}

/** A week of Claude Code and Codex use by six of the class, with varied totals. */
export async function seedAgentUsage(people: Person[]) {
	await query("delete from agent_usage_days");
	const boot = crypto.randomUUID();
	for (const [index, one] of people.slice(0, 6).entries()) {
		for (let back = 0; back < 7; back++) {
			// Each student works at their own pace, busier on some days than others.
			const scale = (0.5 + index * 0.4) * (1 + ((back * 3 + index) % 5) / 4);
			await query(
				`insert into agent_usage_days
				   (user_id, boot_id, day, agent, model, sessions, input_tokens, output_tokens,
				    cache_read_tokens, cache_write_tokens, cost_usd, lines_added, lines_removed)
				 values ($1, $2, current_date - $3::int, 'claude', 'claude-sonnet-4-5', $4,
				         $5, $6, $7, $8, $9, $10, $11)`,
				[
					one.userId,
					boot,
					back,
					1 + Math.round(scale),
					Math.round(18_000 * scale),
					Math.round(42_000 * scale),
					Math.round(310_000 * scale),
					Math.round(26_000 * scale),
					Math.round(0.85 * scale * 100) / 100,
					Math.round(120 * scale),
					Math.round(35 * scale),
				],
			);
			// Half the class also tries Codex, which reports no cost.
			if (index % 2 === 0 && back % 2 === 0) {
				await query(
					`insert into agent_usage_days
					   (user_id, boot_id, day, agent, model, sessions, input_tokens, output_tokens,
					    cache_read_tokens, cache_write_tokens, cost_usd, lines_added, lines_removed)
					 values ($1, $2, current_date - $3::int, 'codex', 'gpt-5-codex', 1,
					         $4, $5, $6, 0, null, $7, $8)`,
					[
						one.userId,
						boot,
						back,
						Math.round(9_000 * scale),
						Math.round(15_000 * scale),
						Math.round(80_000 * scale),
						Math.round(60 * scale),
						Math.round(12 * scale),
					],
				);
			}
		}
	}
}

export const CURRENT_FINGERPRINT = "a41c9e02d7b85f13ce90b6d2f1e8a7c3";
export const OLD_FINGERPRINT = "7be3d0f9152ac6e48d01a9f2c5b7e360";

/** Two images on the server, the newer the default, and the fetch that brought it. */
export async function seedImage() {
	await resetImageStore();
	await putImage({
		version: "2026.10.2",
		fingerprint: OLD_FINGERPRINT,
		health: "passed",
		sizeBytes: Math.round(1.8 * GIB),
	});
	await putImage({
		version: "2026.11.1",
		fingerprint: CURRENT_FINGERPRINT,
		health: "passed",
		nodeVersion: "v24.11.0",
		sizeBytes: Math.round(1.9 * GIB),
		packages: { curl: "8.14.1-3", git: "1:2.47.3-0", zsh: "5.9-8" },
	});
	await setAliases("2026.11.1", "2026.10.2");
	await putCodingAgents({
		claude: { current: "2.1.5", previous: "2.1.4" },
		codex: { current: "0.46.0", previous: "0.45.0" },
	});
	const job = crypto.randomUUID();
	await mkdir(join(IMAGE_JOBS_DIR, job), { recursive: true });
	await writeStatus(job, "fetch", "succeeded", "Done", "2026.11.1");
	await writeLog(job, [
		"fetching image-2026.11.1",
		"signature good",
		"starting imgcheck-1",
		"health check passed",
	]);
}

const MB = 1024 ** 2;

/** A pull cache in use, a three-image seed, and a fortnight of the class's pulls. */
export async function seedDocker(people: Person[]) {
	await resetRegistryJobs();
	const seen = new Date().toISOString();
	await writeRegistryStatus({
		usedBytes: Math.round(6.4 * GIB),
		hubCredentialSet: true,
		lastClearedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
		lastClearReason: "admin",
		imageSizes: {
			"docker.io/library/python:3.12": { bytes: 412 * MB, seenAt: seen },
			"docker.io/library/node:22": { bytes: 395 * MB, seenAt: seen },
			"docker.io/library/postgres:17": { bytes: 154 * MB, seenAt: seen },
			"docker.io/library/redis:7": { bytes: 41 * MB, seenAt: seen },
			"docker.io/library/mysql:8": { bytes: 228 * MB, seenAt: seen },
		},
	});
	await query("delete from docker_seed_jobs");
	await query("delete from docker_seed");
	await query("delete from docker_image_pulls");
	await query("delete from docker_image_presence");
	const seed = ["python:3.12", "node:22", "postgres:17"];
	await query(
		`update settings set docker_ghcr_enabled = false, docker_seed_max_gib = 8,
		 docker_seed_images = $1, docker_seed_images_set = true where id = 1`,
		[JSON.stringify([...seed, "redis:7"])],
	);
	await query(
		`insert into docker_seed (id, images, size_bytes, image_version, built_at)
		 values (1, $1, $2, '2026.11.1', now() - interval '3 days')`,
		[JSON.stringify(seed), Math.round(2.6 * GIB)],
	);
	for (const [index, one] of people.entries()) {
		const extra = index % 3 === 0 ? "redis:7" : index % 3 === 1 ? "mysql:8" : null;
		if (extra) {
			await query(
				`insert into docker_image_pulls (image, workspace_id, day, pulls)
				 values ($1, $2, current_date - $3::int, $4)`,
				[`docker.io/library/${extra}`, one.workspaceId, index, 1 + (index % 4)],
			);
		}
		await query(
			`insert into docker_image_presence (workspace_id, image, in_seed, used) values
			 ($1, 'docker.io/library/python:3.12', true, true),
			 ($1, 'docker.io/library/node:22', true, $2),
			 ($1, 'docker.io/library/postgres:17', true, false)`,
			[one.workspaceId, index % 2 === 0],
		);
	}
}
