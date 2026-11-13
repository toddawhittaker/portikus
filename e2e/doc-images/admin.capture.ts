/**
 * The administrator and instructor images in docs/images. A class of
 * invented students is seeded once; the host's side of backups, the
 * certificate and sign-in is played by the same fakes the browser tests use.
 */
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { putStatus, resetCertificateStore } from "../certificate-jobs";
import {
	addSession,
	createProject,
	loginAs,
	query,
	type TestProject,
	WEB_ORIGIN,
} from "../helpers";
import { resetSiteStore } from "../site-jobs";
import {
	backupDay,
	backupStamp,
	CURRENT_FINGERPRINT,
	OLD_FINGERPRINT,
	seedAgentUsage,
	seedBackups,
	seedDocker,
	seedHealth,
	seedImage,
	seedNetwork,
	seedSite,
} from "./admin-seed";
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

const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

/** The dark shot of an image is named like the light one with `-dark` added. */
function imageName(base: string, colorScheme: Scheme) {
	return colorScheme === "light" ? `${base}.png` : `${base}-dark.png`;
}

/** Carol signs in through the mock provider; her name is made to fit the demo. */
async function asAdmin(page: Page, path: string, colorScheme: Scheme = "light") {
	await page.emulateMedia({ colorScheme });
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
	// A second course, so the instructor's course list has more than one to choose.
	await course(
		"CS 2400: Databases",
		instructor.userId,
		people.slice(5).map((one) => one.userId),
		"traditional",
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
	// Every admin shot shares one health state, so the rail badge and the
	// status bar count the same attention items on every page.
	await seedHealth();
	// The class runs the image the health sample names as current, so no row
	// carries an Old image tag it would not have on a fresh install.
	await query("update workspaces set image_version = $1", ["a41c9e02d7b85f13ce90"]);
});

for (const colorScheme of SCHEMES) {
	test(`users and the intro toggletip (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin", colorScheme);
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page
			.getByRole("button", { name: /^About Account tags/ })
			.first()
			.click();
		await expect(
			page.locator(".pk-toggletip-content[data-state='open']"),
		).toBeVisible();
		if (colorScheme === "light") {
			await shoot(page, "admin-intro-toggletip.png", {
				clip: { x: 0, y: 40, width: 1000, height: 300 },
			});
		}
		await page.keyboard.press("Escape");
		await page.getByTestId("admin-filter-text").fill("");
		await page.getByRole("button", { name: "Show details for Diego Santos" }).click();
		await expect(page.getByRole("region", { name: "Diego Santos" })).toBeVisible();
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-users", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`settings (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin/settings", colorScheme);
		await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible(
			{
				timeout: 15_000,
			},
		);
		await page.waitForTimeout(1000);
		await shoot(page, imageName("admin-settings", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`health (${colorScheme})`, async ({ page }) => {
		await seedHealth();
		await asAdmin(page, "/admin/health", colorScheme);
		await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-health", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`logs (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin/logs", colorScheme);
		await expect(page.getByRole("heading", { name: "Logs", level: 2 })).toBeVisible({
			timeout: 15_000,
		});
		await page.getByLabel("Info", { exact: true }).check();
		await page.getByRole("button", { name: "Apply filters" }).click();
		await page.waitForTimeout(2500);
		await shoot(page, imageName("admin-logs", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`audit (${colorScheme})`, async ({ page }) => {
		const [maya, diego, amara, lukas, priya] = people as [
			Person,
			Person,
			Person,
			Person,
			Person,
		];
		const rows: [string, string, string, string, object, number][] = [
			[maya.userId, maya.workspaceId, "auth.login", "ok", {}, 3],
			[
				"worker",
				diego.workspaceId,
				"workspace.cpu_throttled",
				"ok",
				{ averagePercent: 96 },
				12,
			],
			[amara.userId, amara.workspaceId, "workspace.start_requested", "ok", {}, 25],
			["worker", lukas.workspaceId, "workspace.idle_stopped", "ok", {}, 47],
			[priya.userId, priya.workspaceId, "auth.login", "ok", {}, 63],
			[
				"worker",
				lukas.workspaceId,
				"workspace.start_failed",
				"failed",
				{ errorCode: "TIMEOUT" },
				95,
			],
			[diego.userId, diego.workspaceId, "auth.login", "ok", {}, 130],
			[maya.userId, maya.workspaceId, "workspace.stop_requested", "ok", {}, 180],
		];
		// The list is newest first by row number, so start from an empty table:
		// the seeded rows are then in time order, and the sign-in that opens the
		// page is the newest row at the top.
		await query("delete from audit_events");
		const [carol] = await query<{ id: string }>(
			"select id from users where email = 'carol@example.edu'",
		);
		rows.push([
			carol?.id ?? "",
			diego.workspaceId,
			"workspace.quota_updated",
			"ok",
			{ from: { homeGiB: 5, dockerGiB: 5 }, to: { homeGiB: 10, dockerGiB: 10 } },
			8,
		]);
		rows.sort((a, b) => b[5] - a[5]);
		for (const [who, target, action, result, metadata, minutes] of rows) {
			const actor = who === "worker" ? who : `user:${who}`;
			await query(
				`insert into audit_events (actor, target, action, result, metadata, at)
			 values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`,
				[actor, target, action, result, JSON.stringify(metadata), minutes],
			);
		}
		await asAdmin(page, "/admin/audit", colorScheme);
		await expect(page.getByRole("heading", { name: "Audit", level: 2 })).toBeVisible({
			timeout: 15_000,
		});
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-audit", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`network (${colorScheme})`, async ({ page }) => {
		await seedNetwork();
		await asAdmin(page, "/admin/network", colorScheme);
		await expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await shoot(page, imageName("admin-network", colorScheme));
	});
}

async function openBackups(page: Page, colorScheme: Scheme) {
	await seedBackups();
	await asAdmin(page, "/admin/backups", colorScheme);
	await expect(page.getByRole("heading", { name: "Backups", level: 2 })).toBeVisible({
		timeout: 15_000,
	});
	await page.waitForTimeout(1500);
}

for (const colorScheme of SCHEMES) {
	test(`backups (${colorScheme})`, async ({ page }) => {
		await openBackups(page, colorScheme);
		await shoot(page, imageName("admin-backups", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`certificate (${colorScheme})`, async ({ page }) => {
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
		await asAdmin(page, "/admin/certificate", colorScheme);
		await page.waitForTimeout(2000);
		await shoot(page, imageName("admin-certificate", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`sign-in (${colorScheme})`, async ({ page }) => {
		await seedSite();
		await asAdmin(page, "/admin/signin", colorScheme);
		await expect(page.getByTestId("admin-signin-sso")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await shoot(page, imageName("admin-sign-in", colorScheme));
		await resetSiteStore();
	});
}

for (const colorScheme of SCHEMES) {
	test(`agent usage (${colorScheme})`, async ({ page }) => {
		await seedAgentUsage(people);
		await asAdmin(page, "/admin/agents", colorScheme);
		await expect(page.getByTestId("agent-usage-users")).toBeVisible({
			timeout: 15_000,
		});
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-agents", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`workspace image (${colorScheme})`, async ({ page }) => {
		await seedImage();
		// The tab counts workspaces by the fingerprint they started from; two
		// stopped workspaces still run the previous image.
		await query("update workspaces set image_version = $1 where state = 'running'", [
			CURRENT_FINGERPRINT,
		]);
		await query("update workspaces set image_version = $1 where state = 'stopped'", [
			OLD_FINGERPRINT,
		]);
		await asAdmin(page, "/admin/image", colorScheme);
		await expect(page.getByTestId("image-default")).toHaveText("2026.11.1", {
			timeout: 15_000,
		});
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-image", colorScheme));
		await query("update workspaces set image_version = '2026.11.1'");
	});
}

for (const colorScheme of SCHEMES) {
	test(`docker (${colorScheme})`, async ({ page }) => {
		await seedDocker(people);
		await asAdmin(page, "/admin/docker", colorScheme);
		await expect(page.getByTestId("docker-cache")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-docker", colorScheme));
	});
}

const NEW_HOST = "code.example.edu";

for (const colorScheme of SCHEMES) {
	test(`site address (${colorScheme})`, async ({ page }) => {
		await seedSite();
		// The pre-flight resolves real DNS names; the plan's checks are served as passed.
		await page.route("**/admin/address/preflight", (route) =>
			route.fulfill({
				json: {
					ok: true,
					checks: [
						{ name: "dns-site", result: "passed", message: `${NEW_HOST} resolves.` },
						{
							name: "dns-preview",
							result: "passed",
							message: `Preview names such as portikus-check-1.preview.${NEW_HOST} resolve.`,
						},
						{
							name: "reach-site",
							result: "passed",
							message: `${NEW_HOST} points at this server.`,
						},
						{
							name: "reach-preview",
							result: "passed",
							message: `*.preview.${NEW_HOST} points at this server.`,
						},
					],
				},
			}),
		);
		await asAdmin(page, "/admin/address", colorScheme);
		await expect(
			page.getByRole("heading", { level: 2, name: "Site address", exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("address-host").fill(NEW_HOST);
		await page.getByTestId("address-port").fill("443");
		await page.getByTestId("address-check").click();
		await expect(page.getByTestId("address-preflight-summary")).toHaveText(
			"All DNS checks passed.",
		);
		await page.waitForTimeout(1000);
		await shoot(page, imageName("admin-address", colorScheme));
		await resetSiteStore();
	});
}

for (const colorScheme of SCHEMES) {
	test(`root shell (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin/shell", colorScheme);
		await page.getByRole("button", { name: "Open a root shell" }).click({
			timeout: 15_000,
		});
		const leaf = page.locator(
			'.pk-termgroup:not([hidden]) [data-testid^="terminal-leaf-"]',
		);
		const id = (
			await leaf.first().getAttribute("data-testid", { timeout: 15_000 })
		)?.replace("terminal-leaf-", "");
		const pane = page.getByTestId(`terminal-pane-${id}`);
		await expect(pane).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
		await pane.locator(".xterm-screen").click();
		// The fake helper echoes each line, as a shell shows what was typed.
		for (const line of ["systemctl status portikus-api", "df -h /var/lib/incus"]) {
			await page.keyboard.insertText(line);
			await page.keyboard.press("Enter");
		}
		// The capture draws terminals with WebGL, so there is no row text to wait on.
		await page.waitForTimeout(1500);
		await shoot(page, imageName("admin-shell", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`administrator help (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin/help", colorScheme);
		await expect(page.locator("#admin-users")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await shoot(page, imageName("admin-help", colorScheme));
	});
}

/** A phone-sized page, as student.capture.ts takes its phone shot. */
async function phonePage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		deviceScaleFactor: 1,
	});
	return context.newPage();
}

// Network keeps what its desktop shot above seeded.
const PHONE: [string, string, (page: Page) => Promise<void>][] = [
	[
		"users",
		"/admin",
		(page) =>
			expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 }),
	],
	[
		"health",
		"/admin/health",
		(page) =>
			expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 }),
	],
	[
		"backups",
		"/admin/backups",
		(page) =>
			expect(page.getByRole("heading", { name: "Backups", level: 2 })).toBeVisible({
				timeout: 15_000,
			}),
	],
	[
		"settings",
		"/admin/settings",
		(page) =>
			expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible({
				timeout: 15_000,
			}),
	],
	[
		"network",
		"/admin/network",
		(page) => expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 }),
	],
];

for (const colorScheme of SCHEMES) {
	for (const [tab, path, ready] of PHONE) {
		test(`${tab} on a phone (${colorScheme})`, async ({ browser }) => {
			const page = await phonePage(browser);
			// Fresh samples and reports, so the page does not warn they have gone stale.
			if (tab === "backups") await seedBackups();
			if (tab === "health") await seedHealth();
			await asAdmin(page, path, colorScheme);
			await ready(page);
			await page.waitForTimeout(1500);
			await shoot(page, imageName(`admin-${tab}-phone`, colorScheme));
			await page.context().close();
		});
	}
}

for (const colorScheme of SCHEMES) {
	test(`limits dialog (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin", colorScheme);
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill("Diego Santos");
		await page.getByRole("button", { name: "Show details for Diego Santos" }).click();
		const panel = page.getByRole("region", { name: "Diego Santos" });
		await page
			.getByRole("button", { name: "Edit limits for Diego Santos's workspace" })
			.click();
		await expect(
			page.getByRole("dialog", { name: "Limits for Diego Santos's workspace" }),
		).toBeVisible();
		await expect(panel).toBeVisible();
		await page.waitForTimeout(800);
		await shoot(page, imageName("admin-flow-limits", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`settings with an unsaved change (${colorScheme})`, async ({ page }) => {
		await asAdmin(page, "/admin/settings", colorScheme);
		const field = page.getByTestId("settings-idleStopMinutes");
		await expect(field).toBeVisible({ timeout: 15_000 });
		const before = await field.inputValue();
		await field.fill(before === "45" ? "60" : "45");
		await expect(page.getByRole("button", { name: "Discard changes" })).toBeVisible();
		await page
			.getByRole("button", { name: "Save stop times" })
			.scrollIntoViewIfNeeded();
		await page.waitForTimeout(800);
		await shoot(page, imageName("admin-flow-settings-unsaved", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`backup delete confirmation (${colorScheme})`, async ({ page }) => {
		await openBackups(page, colorScheme);
		await page
			.getByTestId(`backup-set-${backupStamp(backupDay(3))}`)
			.getByTestId("backup-set-menu")
			.click();
		await page.getByTestId("backup-set-delete").click();
		await expect(page.getByTestId("backup-delete-dialog")).toBeVisible();
		await page.waitForTimeout(800);
		await shoot(page, imageName("admin-flow-backup-delete", colorScheme));
	});
}

const studentContexts: BrowserContext[] = [];
let help: { project: TestProject; shell: string } | null = null;

/** A student asks Dr. Okafor for live help in a project, from their own browser. */
async function askForHelp(
	context: BrowserContext,
	workspaceId: string,
	projectId: string,
) {
	const started = await context.request.post(
		`${WEB_ORIGIN}/workspaces/${workspaceId}/projects/${projectId}/live-help`,
		{
			headers: { origin: WEB_ORIGIN },
			data: { helperUserId: instructor.userId, courseId },
		},
	);
	expect(started.status()).toBe(200);
}

/**
 * Maya is stuck on a traceback, runs her checks, shares Weather Now and asks
 * for help; Priya and Hana ask too, so the queue has several students. Done
 * once: the student browsers stay open for every instructor shot.
 */
async function classAsksForHelp(
	browser: Browser,
): Promise<{ project: TestProject; shell: string }> {
	if (help) return help;
	const maya = people[0] as Person;
	const context = await browser.newContext();
	studentContexts.push(context);
	await addSession(context, maya.userId);
	const studentPage = await context.newPage();
	const project = await weatherProject(maya.workspaceId);
	await openProject(studentPage, maya.workspaceId, project.id);
	const shell = await launch(studentPage, maya.workspaceId, project.id, "terminal");
	await expect(studentPage.getByTestId(`terminal-pane-${shell}`)).toHaveAttribute(
		"data-connected",
		"true",
		{ timeout: 15_000 },
	);
	await flaskRunning(maya.workspaceId);
	const base = `${WEB_ORIGIN}/workspaces/${maya.workspaceId}/projects/${project.id}`;
	for (const check of ["tests", "lint"]) {
		const ran = await context.request.post(`${base}/checks/${check}/runs`, {
			headers: { origin: WEB_ORIGIN },
		});
		expect(ran.status()).toBe(201);
	}
	const shared = await context.request.post(`${base}/share`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(shared.ok()).toBe(true);
	await askForHelp(context, maya.workspaceId, project.id);

	for (const [index, name] of [
		[4, "Portfolio Site"],
		[7, "Quiz Game"],
	] as const) {
		const one = people[index] as Person;
		const theirs = await browser.newContext();
		studentContexts.push(theirs);
		await addSession(theirs, one.userId);
		const own = await createProject(one.workspaceId, { name });
		await askForHelp(theirs, one.workspaceId, own.id);
	}
	help = { project, shell };
	return help;
}

test.afterAll(async () => {
	for (const context of studentContexts) await context.close();
});

/** Dr. Okafor's own browser, in the given scheme and size. */
async function asInstructor(page: Page, path: string, colorScheme: Scheme) {
	await page.emulateMedia({ colorScheme });
	await addSession(page.context(), instructor.userId);
	await controllerChecked();
	await page.goto(path);
}

for (const colorScheme of SCHEMES) {
	test(`instructor course list (${colorScheme})`, async ({ page, browser }) => {
		await classAsksForHelp(browser);
		await asInstructor(page, "/course", colorScheme);
		await expect(page.getByTestId("course-list")).toContainText("CS 2400: Databases", {
			timeout: 15_000,
		});
		await page.waitForTimeout(1000);
		await shoot(page, imageName("instructor-courses", colorScheme));
	});

	test(`instructor course (${colorScheme})`, async ({ page, browser }) => {
		await classAsksForHelp(browser);
		await asInstructor(page, `/course/${courseId}`, colorScheme);
		await expect(page.getByTestId("course-live-help")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await shoot(page, imageName("instructor-course", colorScheme));
	});

	test(`instructor shared project (${colorScheme})`, async ({ page, browser }) => {
		const { project } = await classAsksForHelp(browser);
		await asInstructor(page, `/course/${courseId}/shares/${project.id}`, colorScheme);
		await expect(
			page.getByRole("heading", { level: 1, name: project.name }),
		).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1500);
		await shoot(page, imageName("instructor-share", colorScheme));
	});

	test(`instructor live help queue (${colorScheme})`, async ({ page, browser }) => {
		await classAsksForHelp(browser);
		await asInstructor(page, `/course/${courseId}/live`, colorScheme);
		await expect(page.getByTestId("live-sessions")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await shoot(page, imageName("instructor-live", colorScheme));
	});

	test(`instructor live help session (${colorScheme})`, async ({ page, browser }) => {
		const { shell } = await classAsksForHelp(browser);
		await asInstructor(page, `/course/${courseId}/live`, colorScheme);
		await page
			.getByRole("link", { name: "Open live help with Maya Chen on Weather Now" })
			.click({ timeout: 15_000 });
		await expect(page.getByTestId("helper-terminal")).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		// Cleared first, so the dark shot does not show the light shot's lines too.
		await printTo(shell, [
			"\u001b[H\u001b[2Jstudent@ws-maya:~/projects/weather-now$ flask --app app run",
			"Traceback (most recent call last):",
			'  File "/home/student/projects/weather-now/app.py", line 4, in <module>',
			"    import requests",
			"ModuleNotFoundError: No module named 'requests'",
			"student@ws-maya:~/projects/weather-now$",
		]);
		await page.waitForTimeout(1500);
		await shoot(page, imageName("instructor-live-help", colorScheme));
	});

	for (const [name, path, ready] of [
		["course", "", "course-live-help"],
		["live", "/live", "live-sessions"],
	] as const) {
		test(`instructor ${name} on a phone (${colorScheme})`, async ({ browser }) => {
			await classAsksForHelp(browser);
			const page = await phonePage(browser);
			await asInstructor(page, `/course/${courseId}${path}`, colorScheme);
			await expect(page.getByTestId(ready)).toBeVisible({ timeout: 15_000 });
			await page.waitForTimeout(1500);
			await shoot(page, imageName(`instructor-${name}-phone`, colorScheme));
			await page.context().close();
		});
	}
}
