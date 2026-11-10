/**
 * The administrator and instructor images in docs/images. A class of
 * invented students is seeded once; the host's side of backups, the
 * certificate and sign-in is played by the same fakes the browser tests use.
 */
import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { backupSet, hostReport, hostStatus, resetBackups } from "../backup-channel";
import { putStatus, resetCertificateStore } from "../certificate-jobs";
import { addSession, loginAs, query } from "../helpers";
import { putInstallAnswers, resetSiteStore, SITE_VIEW_FILE } from "../site-jobs";
import {
	controllerChecked,
	course,
	flaskRunning,
	launch,
	openProject,
	type Person,
	person,
	printTo,
	shoot,
	weatherProject,
} from "./seed";

test.describe.configure({ mode: "serial" });

const CLASS: [string, string, string][] = [
	["Maya Chen", "maya", "running"],
	["Diego Santos", "dsantos", "running"],
	["Amara Nwosu", "anwosu", "running"],
	["Lukas Becker", "lbecker", "stopped"],
	["Priya Raman", "praman", "running"],
	["Sofia Alvarez", "salvarez", "stopped"],
	["Jonah Kim", "jkim", "stopped"],
	["Hana Sato", "hsato", "running"],
	["Omar Haddad", "ohaddad", "stopped"],
];

let people: Person[] = [];
let instructor: Person;
let courseId = "";

/** Carol signs in through the mock provider; her name is made to fit the demo. */
async function asAdmin(page: Page, path: string) {
	await loginAs(page, "carol");
	await query(
		"update users set display_name = 'Carol Whitfield' where email = 'carol@example.edu'",
	);
	await controllerChecked();
	await page.goto(path);
}

test.beforeAll(async () => {
	people = [];
	for (const [name, username, state] of CLASS) {
		people.push(await person(name, username, { state }));
	}
	instructor = await person("Dr. Ivy Okafor", "okafor", { role: "instructor" });
	courseId = await course(
		"CS 1210: Programming for the Web",
		instructor.userId,
		people.map((one) => one.userId),
	);
	const diego = people[1] as Person;
	await query(
		"update workspaces set cpu_throttle = $2, limits_config = $3::jsonb where id = $1",
		[
			diego.workspaceId,
			JSON.stringify({
				at: new Date(Date.now() - 12 * 60_000).toISOString(),
				averagePercent: 96,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "25ms/100ms",
			}),
			JSON.stringify({ memoryMiB: 6144 }),
		],
	);
});

test("users and the intro toggletip", async ({ page }) => {
	await asAdmin(page, "/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page
		.getByRole("button", { name: /^About Image/ })
		.first()
		.click();
	await expect(page.locator(".pk-toggletip-content[data-state='open']")).toBeVisible();
	await shoot(page, "admin-intro-toggletip.png", {
		clip: { x: 0, y: 40, width: 1000, height: 300 },
	});
	await page.keyboard.press("Escape");
	await page.getByTestId("admin-filter-text").fill("");
	await page.getByRole("button", { name: "Show details for Diego Santos" }).click();
	await expect(page.getByRole("region", { name: "Diego Santos" })).toBeVisible();
	await page.waitForTimeout(1500);
	await shoot(page, "admin-users.png");
});

test("settings", async ({ page }) => {
	await asAdmin(page, "/admin/settings");
	await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible({
		timeout: 15_000,
	});
	await page.waitForTimeout(1000);
	await shoot(page, "admin-settings.png");
});

const GIB = 1024 ** 3;

test("health", async ({ page }) => {
	await query("delete from health_samples");
	for (let minutes = 24 * 60; minutes >= 0; minutes -= 30) {
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
					runningWorkspaces: Math.round(1 + busy * 5),
				}),
			],
		);
	}
	await asAdmin(page, "/admin/health");
	await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1500);
	await shoot(page, "admin-health.png");
});

test("logs", async ({ page }) => {
	await asAdmin(page, "/admin/logs");
	await expect(page.getByRole("heading", { name: "Logs", level: 2 })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByLabel("Info", { exact: true }).check();
	await page.getByRole("button", { name: "Apply filters" }).click();
	await page.waitForTimeout(2500);
	await shoot(page, "admin-logs.png");
});

test("audit", async ({ page }) => {
	const [maya, diego, amara, lukas, priya] = people as [
		Person,
		Person,
		Person,
		Person,
		Person,
	];
	const rows: [string, string, string, string, object, number][] = [
		[maya.userId, maya.workspaceId, "auth.login", "success", {}, 3],
		[
			"worker",
			diego.workspaceId,
			"workspace.cpu_throttled",
			"success",
			{ averagePercent: 96 },
			12,
		],
		[amara.userId, amara.workspaceId, "workspace.start_requested", "success", {}, 25],
		["worker", lukas.workspaceId, "workspace.idle_stopped", "success", {}, 47],
		[priya.userId, priya.workspaceId, "auth.login", "success", {}, 63],
		[
			"worker",
			lukas.workspaceId,
			"workspace.start_failed",
			"failed",
			{ errorCode: "TIMEOUT" },
			95,
		],
		[diego.userId, diego.workspaceId, "auth.login", "success", {}, 130],
		[maya.userId, maya.workspaceId, "workspace.stop_requested", "success", {}, 180],
	];
	rows.sort((a, b) => b[5] - a[5]);
	for (const [who, target, action, result, metadata, minutes] of rows) {
		const actor = who === "worker" ? who : `user:${who}`;
		await query(
			`insert into audit_events (actor, target, action, result, metadata, at)
			 values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`,
			[actor, target, action, result, JSON.stringify(metadata), minutes],
		);
	}
	await asAdmin(page, "/admin/audit");
	await expect(page.getByRole("heading", { name: "Audit", level: 2 })).toBeVisible({
		timeout: 15_000,
	});
	await page.waitForTimeout(1500);
	await shoot(page, "admin-audit.png");
});

test("network", async ({ page }) => {
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
	await asAdmin(page, "/admin/network");
	await expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1000);
	await shoot(page, "admin-network.png");
});

test("backups", async ({ page }) => {
	await resetBackups();
	const rows = await query<{ incus_instance_name: string }>(
		"select incus_instance_name from workspaces where label not like 'ws-old-%'",
	);
	const instances = rows.map((row) => row.incus_instance_name);
	const day = (back: number) => {
		const at = new Date(Date.now() - back * 86_400_000);
		at.setUTCHours(7, 30, 0, 0);
		return at;
	};
	const stamp = (at: Date) =>
		at.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
	const last = day(0);
	hostReport(
		hostStatus({
			vm: "portikus",
			lastRun: {
				startedAt: last.toISOString(),
				endedAt: new Date(last.getTime() + 11 * 60_000).toISOString(),
				result: "success",
			},
			nextRunAt: day(-1).toISOString(),
			sets: [0, 1, 2, 3, 4, 5, 6].map((back) =>
				backupSet(stamp(day(back)), instances, {
					sizeBytes: Math.round((38 - back * 0.7) * GIB),
				}),
			),
		}),
	);
	await asAdmin(page, "/admin/backups");
	await expect(page.getByRole("heading", { name: "Backups", level: 2 })).toBeVisible({
		timeout: 15_000,
	});
	await page.waitForTimeout(1500);
	await shoot(page, "admin-backups.png");
});

test("certificate", async ({ page }) => {
	await resetCertificateStore();
	await putStatus({
		settings: {
			source: "acme",
			directory: "https://acme-v02.api.letsencrypt.org/directory",
			email: "it-admin@example.edu",
			eab: null,
			challenge: {
				mode: "dns01",
				provider: "cloudflare",
				fields: {},
				secretsSet: { api_token: true },
			},
		},
		issuer: "CN=R11,O=Let's Encrypt,C=US",
		notAfter: new Date(Date.now() + 62 * 86_400_000).toISOString(),
		renewal: { ok: true, message: null },
	});
	await asAdmin(page, "/admin/certificate");
	await page.waitForTimeout(2000);
	await shoot(page, "admin-certificate.png");
});

test("sign-in", async ({ page }) => {
	await resetSiteStore();
	await putInstallAnswers(
		"portikus_admin_email: it-admin@example.edu\nportikus_dex_upstream: google\n" +
			"portikus_public_host: portikus.example.edu\nportikus_storage: file\n" +
			"portikus_storage_size: 500\nportikus_tls: acme\n",
	);
	await writeFile(
		SITE_VIEW_FILE,
		JSON.stringify({
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
		}),
	);
	await asAdmin(page, "/admin/signin");
	await expect(page.getByTestId("admin-signin-sso")).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1000);
	await shoot(page, "admin-sign-in.png");
	await resetSiteStore();
});

test("instructor course and live help", async ({ page, browser }) => {
	const maya = people[0] as Person;
	// Maya asks for help from her own browser.
	const student = await browser.newContext();
	const studentPage = await student.newPage();
	await addSession(student, maya.userId);
	const again = maya;
	const project = await weatherProject(again.workspaceId);
	await openProject(studentPage, again.workspaceId, project.id);
	const shell = await launch(studentPage, again.workspaceId, project.id, "terminal");
	await expect(studentPage.getByTestId(`terminal-pane-${shell}`)).toHaveAttribute(
		"data-connected",
		"true",
		{ timeout: 15_000 },
	);
	await flaskRunning(again.workspaceId);
	const started = await studentPage.request.post(
		`/workspaces/${again.workspaceId}/projects/${project.id}/live-help`,
		{
			headers: { origin: new URL(studentPage.url()).origin },
			data: { helperUserId: instructor.userId, courseId },
		},
	);
	expect(started.status()).toBe(200);

	// The instructor's own browser.
	await addSession(page.context(), instructor.userId);
	await page.goto(`/course/${courseId}`);
	await expect(page.getByTestId("course-live-help")).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1000);
	await shoot(page, "instructor-course.png");

	await page.getByTestId("course-live-help").click();
	await page
		.getByRole("link", { name: "Open live help with Maya Chen on Weather Now" })
		.click();
	const terminal = page.getByTestId("helper-terminal");
	await expect(terminal).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
	await printTo(shell, [
		"student@ws-maya:~/projects/weather-now$ flask --app app run",
		"Traceback (most recent call last):",
		'  File "/home/student/projects/weather-now/app.py", line 4, in <module>',
		"    import requests",
		"ModuleNotFoundError: No module named 'requests'",
		"student@ws-maya:~/projects/weather-now$",
	]);
	await page.waitForTimeout(1000);
	await shoot(page, "instructor-live-help.png");
	await student.close();
});
