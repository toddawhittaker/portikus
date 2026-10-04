import * as crypto from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Request,
	type Route,
} from "@playwright/test";
import pg from "pg";
import { dexLocalSubject } from "../packages/auth/dist/dex-subject.js";
import { base32Decode, totpCode, totpStep } from "../packages/auth/dist/totp.js";
import { API_ORIGIN, FAKE_AGENT_URL, MOCK_ISSUER, WEB_ORIGIN } from "./ports";

/**
 * The visible toast carrying this text. Radix Toast also renders a hidden
 * copy of the same words for screen readers during the first second after
 * it appears, so a bare text locator matches twice and fails strict mode.
 */
export function toast(page: Page, text: string): Locator {
	return page.locator(".pk-toast").filter({ hasText: text });
}

/** The mock identity provider's users (packages/auth testing). */
export type MockUser =
	| "alice"
	| "bob"
	| "carol"
	| "dave"
	| "erin"
	| "frank"
	| "gail"
	| "lena"
	| "nina"
	| "admin";

/**
 * Log in through the browser: click Sign in, pick a user on the mock
 * provider's account list, and come back to the web app.
 */
export async function loginAs(page: Page, key: MockUser): Promise<void> {
	await page.goto("/");
	await page.click("[data-testid=signin]");
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.click(`[data-testid=mock-user-${key}]`);
	await page.waitForURL(`${WEB_ORIGIN}/**`);
}

/**
 * Log in through the API request context. `/auth/login` redirects to the
 * mock's account list; asking for that same URL with `user=<key>` redirects
 * back through `/auth/callback`. The session cookie stays in the context.
 */
export async function apiLoginAs(
	request: APIRequestContext,
	key: MockUser,
): Promise<void> {
	const authorize = await request.get("/auth/login");
	const authorizeUrl = authorize.url();
	if (!authorizeUrl.includes("/authorize")) {
		throw new Error(`expected the mock authorize page, got ${authorizeUrl}`);
	}
	await request.get(`${authorizeUrl}&user=${key}`);
}

/**
 * Database helpers for the terminal tests. The worker does not run in the
 * end-to-end environment, so no container is ever created. Each test makes
 * its own student, workspace and session straight in the database and points
 * the workspace at the fake workspace agent that playwright.config.ts starts.
 */

export { API_ORIGIN, MOCK_ISSUER, WEB_ORIGIN };

/** Matches the fake agent started by playwright.config.ts. */
export const FAKE_AGENT_TOKEN = "e2e-agent-token";

// `pnpm test:e2e` points this at a database created for the run, not the
// shared server database the URL named when the process started.
const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

/** Run one statement on the test database. A client per call needs no teardown. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	values: unknown[] = [],
): Promise<T[]> {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		const result = await client.query<T>(text, values);
		return result.rows;
	} finally {
		await client.end();
	}
}

export interface TestStudent {
	userId: string;
	workspaceId: string;
	sessionToken: string;
}

/**
 * Create a user with the given role and a session, and put the session
 * cookie in the browser context.
 */
export async function createSignedInUser(
	context: BrowserContext,
	role: "student" | "administrator",
): Promise<{ userId: string; sessionToken: string }> {
	const subject = `e2e-${crypto.randomUUID()}`;
	const name = role === "student" ? "E2E Student" : "E2E Admin";
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, $5) returning id`,
		[MOCK_ISSUER, subject, `${subject}@example.edu`, name, role],
	);
	if (!user) throw new Error("could not create the test user");
	const sessionToken = await addSession(context, user.id);
	return { userId: user.id, sessionToken };
}

/** Give `userId` a session and put its cookie in the browser context. */
export async function addSession(
	context: BrowserContext,
	userId: string,
): Promise<string> {
	const sessionToken = crypto.randomBytes(32).toString("base64url");
	await query(
		`insert into sessions (id, user_id, expires_at)
		 values ($1, $2, now() + interval '1 hour')`,
		[crypto.createHash("sha256").update(sessionToken).digest("hex"), userId],
	);
	await context.addCookies([
		{ name: "portikus_session", value: sessionToken, url: WEB_ORIGIN },
	]);
	return sessionToken;
}

/**
 * A Dex local-password administrator of its own, signed in, like the local
 * administrator (SPEC.md sections 5.1 and 5.3). It never touches the shared
 * "admin" account change-password.spec.ts uses.
 */
export async function createLocalPasswordAdmin(
	context: BrowserContext,
	options: { prefix: string; displayName: string; mustChange: boolean },
): Promise<string> {
	const id = `${options.prefix}-${crypto.randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role,
		   granted_role, must_change_password)
		 values ($1, $2, $3, $4, 'administrator', 'administrator', $5)
		 returning id`,
		[
			MOCK_ISSUER,
			dexLocalSubject(id),
			`${id}@example.edu`,
			options.displayName,
			options.mustChange,
		],
	);
	if (!user) throw new Error("could not create the test user");
	await addSession(context, user.id);
	// Past two-step sign-in; e2e/second-factor.spec.ts covers it.
	await query("update sessions set second_factor_at = now() where user_id = $1", [
		user.id,
	]);
	return user.id;
}

/**
 * An authenticator app for two-step sign-in (SPEC.md section 24.13): codes
 * computed from the key the setup page shows. Each code works once, so it
 * hands out a later time step each time, waiting for the clock when the
 * one-step drift window is used up.
 */
export class TestAuthenticator {
	private lastStep = 0;
	constructor(private readonly secret: Buffer) {}

	static fromKey(key: string): TestAuthenticator {
		return new TestAuthenticator(base32Decode(key));
	}

	async nextCode(): Promise<string> {
		let now = totpStep(Date.now());
		while (this.lastStep >= now + 1) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			now = totpStep(Date.now());
		}
		this.lastStep = Math.max(this.lastStep + 1, now);
		return totpCode(this.secret, this.lastStep);
	}
}

/**
 * Finish the setup page with a test authenticator and continue past the
 * recovery codes. Returns the authenticator and the codes it showed.
 */
export async function enrolSecondFactor(
	page: Page,
): Promise<{ app: TestAuthenticator; codes: string[] }> {
	await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await expect(
		page.getByRole("heading", { name: "Set up two-step sign-in" }),
	).toBeVisible();
	const key = (await page.getByTestId("totp-secret").textContent()) ?? "";
	const app = TestAuthenticator.fromKey(key);
	await page.getByLabel("Code from your app").fill(await app.nextCode());
	await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
	await expect(
		page.getByRole("heading", { name: "Save your recovery codes" }),
	).toBeVisible();
	const codes = await page
		.getByTestId("recovery-codes")
		.getByRole("listitem")
		.allTextContents();
	await page.getByRole("button", { name: "I have saved them, continue" }).click();
	await expect(page).not.toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	return { app, codes };
}

/**
 * Create a student, their workspace and a session, and put the session
 * cookie in the browser context. The login flow itself is covered by
 * auth.spec.ts; here it would only get in the way of test isolation.
 */
export async function createStudent(
	context: BrowserContext,
	options: { state?: string } = {},
): Promise<TestStudent> {
	const { userId, sessionToken } = await createSignedInUser(context, "student");

	const workspaceId = crypto.randomUUID();
	await query(
		`insert into workspaces
		   (id, owner_user_id, label, incus_instance_name, state, desired_state,
		    agent_address, agent_token)
		 values ($1, $2, $3, $4, $5, 'running', '127.0.0.1', $6)`,
		[
			workspaceId,
			userId,
			// Labels are unique, so each test workspace gets the fallback form
			// the API would give a user with no username (SPEC.md §14.3).
			`ws-${workspaceId.replace(/-/g, "").slice(0, 8)}`,
			`ws-${workspaceId.replace(/-/g, "").slice(0, 24)}`,
			options.state ?? "running",
			`${FAKE_AGENT_TOKEN}:${workspaceId}`,
		],
	);

	return { userId, workspaceId, sessionToken };
}

export async function setWorkspaceState(
	workspaceId: string,
	state: string,
): Promise<void> {
	await query("update workspaces set state = $2, updated_at = now() where id = $1", [
		workspaceId,
		state,
	]);
}

/**
 * Wait until the saved layout holds a leaf for this terminal. The browser
 * writes the layout at most once a second (SPEC.md §7.5), and an ended
 * terminal with no saved pane is listing history rather than a tab
 * (SPEC.md §9.7), so a test that ends a terminal and then expects its tab
 * or pane back has to wait for the write first.
 */
export async function waitForSavedLeaf(
	projectId: string,
	terminalId: string,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const rows = await query<{ layout: unknown }>(
					"select layout from projects where id = $1",
					[projectId],
				);
				return JSON.stringify(rows[0]?.layout ?? null).includes(terminalId);
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
}

/** Mark a terminal ended, the way stopping a workspace does. */
export async function endTerminal(terminalId: string): Promise<void> {
	await query("update terminals set ended_at = now() where id = $1", [terminalId]);
}

export async function terminalIds(
	workspaceId: string,
	projectId?: string,
): Promise<string[]> {
	const rows = projectId
		? await query<{ id: string }>(
				`select id from terminals where workspace_id = $1 and project_id = $2
				 order by position`,
				[workspaceId, projectId],
			)
		: await query<{ id: string }>(
				"select id from terminals where workspace_id = $1 order by position",
				[workspaceId],
			);
	return rows.map((row) => row.id);
}

/** Where a project directory lives inside the workspace (SPEC.md §7.1). */
function projectPath(slug: string): string {
	return `/home/student/projects/${slug}`;
}

/** The web route of a workspace, and of one project inside it. */
export function workspacePath(workspaceId: string, projectId?: string): string {
	return projectId
		? `/workspaces/${workspaceId}/projects/${projectId}`
		: `/workspaces/${workspaceId}`;
}

/** The work area's tab strip. */
export function workTabs(page: Page): Locator {
	return page.getByTestId("work-tabs");
}

/** Open a new terminal from the launcher menu. */
export async function newTerminal(page: Page): Promise<void> {
	await page.getByTestId("launcher").click();
	await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
}

/** Wait for a pane's terminal WebSocket to be open. */
export async function expectConnected(page: Page, terminalId: string): Promise<void> {
	await expect(
		page.locator(`[data-testid=terminal-pane-${terminalId}]`),
	).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
}

export interface TestProject {
	id: string;
	slug: string;
	name: string;
	path: string;
}

/**
 * Create a project the way a student would end up with one: a row in the
 * database and a directory the fake agent reports from `~/projects`.
 */
export async function createProject(
	workspaceId: string,
	options: { name: string; slug?: string; gitInit?: boolean },
): Promise<TestProject> {
	const slug = options.slug ?? slugOf(options.name);
	const path = projectPath(slug);
	const [row] = await query<{ id: string }>(
		`insert into projects (workspace_id, slug, name, path, source)
		 values ($1, $2, $3, $4, 'new') returning id`,
		[workspaceId, slug, options.name, path],
	);
	if (!row) throw new Error("could not create the test project");
	await seedProjectDir(workspaceId, slug, options.gitInit ?? true);
	return { id: row.id, slug, name: options.name, path };
}

/**
 * Seed a directory under one workspace's `~/projects`, with no row. The fake
 * agent keeps a listing per workspace, so tests running side by side do not
 * discover each other's directories.
 */
export async function seedProjectDir(
	workspaceId: string,
	slug: string,
	isGitRepo = true,
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ slug, isGitRepo, key: workspaceId }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused to seed ${slug}: ${response.status}`);
	}
}

/**
 * Seed one file inside a seeded project directory, the way a shell or a
 * coding agent would create it. Missing parent directories are created.
 */
export async function seedFile(
	workspaceId: string,
	slug: string,
	path: string,
	content: string | Buffer,
): Promise<void> {
	// Bytes travel as base64, so an image arrives intact.
	const body =
		typeof content === "string"
			? { content }
			: { content: content.toString("base64"), encoding: "base64" };
	const response = await fetch(`${FAKE_AGENT_URL}/__test/files`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, path: `${slug}/${path}`, ...body }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused to seed ${path}: ${response.status}`);
	}
}

/**
 * Open a project whose saved layout already has one file tab, with the file
 * already on disk (SPEC.md §13.1).
 */
export async function openFileTab(
	page: Page,
	student: TestStudent,
	name: string,
	path: string,
	content: string | Buffer,
): Promise<TestProject> {
	const project = await createProject(student.workspaceId, { name });
	await seedFile(student.workspaceId, project.slug, path, content);
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({ tabs: [{ id: `file:${path}`, root: { type: "file", path } }] }),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId(`file-pane-${path}`)).toBeVisible({ timeout: 15_000 });
	return project;
}

/** Read a seeded file back, to check what a write actually stored. */
export async function readSeededFile(
	workspaceId: string,
	slug: string,
	path: string,
): Promise<string> {
	const query = new URLSearchParams({ key: workspaceId, path: `${slug}/${path}` });
	const response = await fetch(`${FAKE_AGENT_URL}/__test/files?${query}`);
	if (!response.ok) {
		throw new Error(`the fake agent has no ${path}: ${response.status}`);
	}
	return ((await response.json()) as { content: string }).content;
}

/** Remove a directory from the fake agent, as deleting it in a shell would. */
export async function removeProjectDir(
	workspaceId: string,
	slug: string,
): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/projects/${encodeURIComponent(slug)}?key=${workspaceId}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		throw new Error(`the fake agent refused to remove ${slug}: ${response.status}`);
	}
}

/**
 * Rename a project directory the way `mv` in the workspace shell does: the
 * same directory under a new name, so its identity is unchanged.
 */
export async function moveProjectDir(
	workspaceId: string,
	from: string,
	to: string,
): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/projects/${encodeURIComponent(from)}/move?key=${workspaceId}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ to }),
		},
	);
	if (!response.ok) {
		throw new Error(`the fake agent refused to move ${from}: ${response.status}`);
	}
}

/** The directories the fake agent currently has for this workspace. */
export async function projectDirs(workspaceId: string): Promise<string[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/projects?key=${workspaceId}`);
	if (!response.ok) {
		throw new Error(`the fake agent refused to list: ${response.status}`);
	}
	return ((await response.json()) as { slugs: string[] }).slugs;
}

/**
 * Seed the Git answers the fake agent gives for one project: the status of
 * the repository and a diff per path (SPEC.md §12.1, §12.6).
 */
export async function seedGit(
	workspaceId: string,
	slug: string,
	answer: { status?: unknown; diffs?: Record<string, unknown> },
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/git`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, slug, ...answer }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the Git seed: ${response.status}`);
	}
}

/** Seed the matches the fake agent answers a search of one project with. */
export async function seedSearch(
	workspaceId: string,
	slug: string,
	matches: unknown[],
	truncated = false,
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/search`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, slug, matches, truncated }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the search seed: ${response.status}`);
	}
}

/** What the last search of one project asked the fake agent for. */
export async function lastSearch(
	workspaceId: string,
	slug: string,
): Promise<{ q: string; hidden: boolean } | null> {
	const query = new URLSearchParams({ key: workspaceId, slug });
	const response = await fetch(`${FAKE_AGENT_URL}/__test/search/last?${query}`);
	if (!response.ok) {
		throw new Error(`the fake agent refused to report: ${response.status}`);
	}
	return (await response.json()) as { q: string; hidden: boolean } | null;
}

/**
 * Push one events frame to every browser watching this project, the way a
 * change on disk would (SPEC.md §11.4). Returns how many sockets got it.
 */
export async function pushEvent(
	workspaceId: string,
	slug: string,
	frame: unknown,
): Promise<number> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/events`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, slug, frame }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the event: ${response.status}`);
	}
	return ((await response.json()) as { sent: number }).sent;
}

/**
 * Seed what the workspace is listening on (BROWSER-HANDLING.md §11.1). The
 * list replaces whatever was there, so passing an empty array is how a test
 * says the application has stopped. `previewReachability` may be left out: it
 * defaults to "reachable", the way an application bound to 0.0.0.0 looks.
 * Pass "unknown" for one bound only to loopback, which makes the API ask the
 * agent for a forward before it issues a grant.
 */
export async function seedListening(
	workspaceId: string,
	services: {
		port: number;
		addresses?: string[];
		protocolHint?: "http" | "https" | "unknown";
		previewReachability?: "reachable" | "forwarded" | "unknown";
		system?: boolean;
		process?: { pid?: number; command?: string; commandLine?: string };
		container?: { id?: string; name?: string };
	}[],
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, services }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the listening seed: ${response.status}`);
	}
}

/**
 * Start a real HTTP and WebSocket application inside the fake agent and
 * report it as listening, so a preview test drives actual traffic. It answers
 * a small HTML page on `GET /` and echoes every WebSocket frame back with an
 * `echo:` prefix. Returns the port it bound.
 */
export async function startPreviewApp(
	workspaceId: string,
	title = "Portikus test app",
	/** Sent as `X-Frame-Options` by the app, for the refused-framing path. */
	frameOptions?: string,
): Promise<number> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/app`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, title, frameOptions }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused to start an app: ${response.status}`);
	}
	return ((await response.json()) as { port: number }).port;
}

export async function projectIds(workspaceId: string): Promise<string[]> {
	const rows = await query<{ id: string }>(
		"select id from projects where workspace_id = $1 order by created_at",
		[workspaceId],
	);
	return rows.map((row) => row.id);
}

/** The same rule as `slugify` in packages/contracts, kept local to e2e. */
function slugOf(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
}

/** Revoke every session of one user, as disabling the account would. */
export async function deleteSessions(userId: string): Promise<void> {
	await query("delete from sessions where user_id = $1", [userId]);
}

type StorageFigure = { usedBytes: number; totalBytes: number } | null;

/**
 * Set the storage figures the fake agent reports in `/usage` for one
 * workspace (SPEC.md §19.2). A class left out reports null.
 */
export async function seedStorage(
	workspaceId: string,
	figures: { home?: StorageFigure; docker?: StorageFigure; recovery?: StorageFigure },
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/storage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, ...figures }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the storage seed: ${response.status}`);
	}
}

/** Make this workspace's next recovery points fail as full, or stop doing so. */
export async function setRecoveryFull(
	workspaceId: string,
	full: boolean,
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/recovery`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, storageFull: full }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the recovery seed: ${response.status}`);
	}
}

/** Make this workspace's restores fail as partly done (RESTORE_INCOMPLETE). */
export async function setRestoreIncomplete(workspaceId: string): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/recovery`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, restoreIncomplete: true }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused the recovery seed: ${response.status}`);
	}
}

/** The WCAG levels every axe scan checks: 2.0, 2.1 and 2.2 AA (SPEC.md 25.8). */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/**
 * An axe builder for the page once every finite CSS transition and animation
 * has finished. Axe reads computed colours, so a dialog opening or a theme
 * changing mid-scan reports intermediate colours as contrast failures.
 */
export async function settledAxe(page: Page): Promise<AxeBuilder> {
	await page.waitForFunction(() =>
		document
			.getAnimations()
			.every(
				(a) =>
					a.playState !== "running" ||
					a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
			),
	);
	return new AxeBuilder({ page });
}

/** Scan the page, or only the given selectors, and expect no WCAG violations. */
export async function expectNoViolations(
	page: Page,
	...include: string[]
): Promise<void> {
	let builder = (await settledAxe(page)).withTags(WCAG_TAGS);
	for (const selector of include) builder = builder.include(selector);
	const results = await builder.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** The WCAG 2 contrast ratio between two rgb() colours. */
export function contrast(first: string, second: string): number {
	const luminance = (colour: string) => {
		const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
			const channel = Number(part) / 255;
			return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
	};
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/**
 * Answers the API's data for `pattern` while leaving page loads alone: an
 * admin tab's path, such as /admin/image, is also the URL of its data
 * (SPEC.md section 20.1), and only the request type tells them apart.
 */
export async function routeApi(
	page: Page,
	pattern: string,
	handler: (route: Route, request: Request) => Promise<unknown> | unknown,
): Promise<void> {
	await page.route(pattern, (route, request) =>
		request.resourceType() === "document" ? route.fallback() : handler(route, request),
	);
}

/** Carol, the mock provider's administrator, on the admin page. */
export async function openAdmin(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

/** A student with a workspace, made in a context of its own so carol keeps her session. */
export async function studentIn(
	browser: Browser,
	prefix: string,
): Promise<TestStudent & { name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `${prefix} ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name };
}

/** The reason `finishOperation` audits for a failed Replace home, in the worker's words. */
const REPLACE_HOME_ERROR = "the host could not import the home: no space left";

/** Play the worker's end of an operation: clear it, then audit the result (ADR 0021). */
export async function finishOperation(
	workspaceId: string,
	action: string,
	ok: boolean,
): Promise<void> {
	await query(
		`update workspaces set pending_operation = null, pending_operation_at = null,
		 pending_operation_by = null, state = $2, error_code = $3 where id = $1`,
		[workspaceId, ok ? "stopped" : "error", ok ? null : "CONTROLLER_TIMEOUT"],
	);
	// Replace home audits its reason in words; the others an error code (apps/worker).
	const failure =
		action === "workspace.home_replace_failed"
			? { error: REPLACE_HOME_ERROR }
			: { errorCode: "CONTROLLER_TIMEOUT" };
	await query(
		`insert into audit_events (actor, target, action, result, metadata)
		 values ('worker', $1, $2, $3, $4)`,
		[workspaceId, action, ok ? "ok" : "failed", JSON.stringify(ok ? {} : failure)],
	);
}

/**
 * Start recording the text of every toast the page shows, and return a
 * reader for the list. A success toast closes itself, so counting what is
 * on screen later would miss it.
 */
export async function recordToasts(page: Page): Promise<() => Promise<string[]>> {
	await page.evaluate(() => {
		const shown: string[] = [];
		(window as unknown as { shownToasts: string[] }).shownToasts = shown;
		new MutationObserver((changes) => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					if (!(node instanceof HTMLElement)) continue;
					const toasts = node.matches(".pk-toast")
						? [node]
						: [...node.querySelectorAll(".pk-toast")];
					for (const added of toasts) shown.push(added.textContent ?? "");
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	return () =>
		page.evaluate(() => (window as unknown as { shownToasts: string[] }).shownToasts);
}

/** Filter the admin table to a user and open their detail panel once a region shows. */
export async function openDetail(page: Page, name: string, readyRegion: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByRole("region", { name: readyRegion })).toBeVisible();
	return panel;
}

/** The named headers a response carries, for replaying into a fulfilled route. */
export function headersOf(response: Response, names: string[]): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of names) {
		const value = response.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	return headers;
}

/** The `name=value` part of each Set-Cookie line, for the next hop. */
export function cookiePairs(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((line) => line.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

/**
 * The open toggletip's visible panel. It is hidden from assistive technology
 * by design (a live region reads the text), so it has no role to find it by.
 */
export function openToggletip(page: Page): Locator {
	return page.locator(".pk-toggletip-content[data-state='open']");
}
