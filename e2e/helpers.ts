import * as crypto from "node:crypto";
import {
	type APIRequestContext,
	type BrowserContext,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";
import pg from "pg";

/** The mock identity provider's users (packages/auth testing). */
export type MockUser = "alice" | "bob" | "carol" | "dave";

/**
 * Log in through the browser: click Sign in, pick a user on the mock
 * provider's account list, and come back to the web app.
 */
export async function loginAs(page: Page, key: MockUser): Promise<void> {
	await page.goto("/");
	await page.click("[data-testid=signin]");
	await page.waitForURL(/127\.0\.0\.1:3002\/authorize/);
	await page.click(`[data-testid=mock-user-${key}]`);
	await page.waitForURL(/127\.0\.0\.1:5173/);
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

export const WEB_ORIGIN = "http://127.0.0.1:5173";
export const MOCK_ISSUER = "http://127.0.0.1:3002";

/** Matches the fake agent started by playwright.config.ts. */
export const FAKE_AGENT_TOKEN = "e2e-agent-token";

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
 * Create a student, their workspace and a session, and put the session
 * cookie in the browser context. The login flow itself is covered by
 * auth.spec.ts; here it would only get in the way of test isolation.
 */
export async function createStudent(
	context: BrowserContext,
	options: { state?: string } = {},
): Promise<TestStudent> {
	const subject = `e2e-${crypto.randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'student') returning id`,
		[MOCK_ISSUER, subject, `${subject}@example.edu`, "E2E Student"],
	);
	if (!user) throw new Error("could not create the test user");

	const workspaceId = crypto.randomUUID();
	await query(
		`insert into workspaces
		   (id, owner_user_id, incus_instance_name, state, desired_state,
		    agent_address, agent_token)
		 values ($1, $2, $3, $4, 'running', '127.0.0.1', $5)`,
		[
			workspaceId,
			user.id,
			`ws-${workspaceId.replace(/-/g, "").slice(0, 24)}`,
			options.state ?? "running",
			`${FAKE_AGENT_TOKEN}:${workspaceId}`,
		],
	);

	const sessionToken = crypto.randomBytes(32).toString("base64url");
	await query(
		`insert into sessions (id, user_id, expires_at)
		 values ($1, $2, now() + interval '1 hour')`,
		[crypto.createHash("sha256").update(sessionToken).digest("hex"), user.id],
	);

	await context.addCookies([
		{ name: "portikus_session", value: sessionToken, url: WEB_ORIGIN },
	]);

	return { userId: user.id, workspaceId, sessionToken };
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

/** Where the fake workspace agent from playwright.config.ts listens. */
const FAKE_AGENT_URL = `http://127.0.0.1:${process.env.FAKE_AGENT_PORT ?? "7400"}`;

/** Where a project directory lives inside the workspace (SPEC.md §7.1). */
export function projectPath(slug: string): string {
	return `/home/student/projects/${slug}`;
}

/** The web route of a workspace, and of one project inside it (plan, E1). */
export function workspacePath(workspaceId: string, projectId?: string): string {
	return projectId
		? `/workspaces/${workspaceId}/projects/${projectId}`
		: `/workspaces/${workspaceId}`;
}

/** The work area's tab strip. */
export function workTabs(page: Page): Locator {
	return page.getByTestId("work-tabs");
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

/** The directories the fake agent currently has for this workspace. */
export async function projectDirs(workspaceId: string): Promise<string[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/projects?key=${workspaceId}`);
	if (!response.ok) {
		throw new Error(`the fake agent refused to list: ${response.status}`);
	}
	return ((await response.json()) as { slugs: string[] }).slugs;
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
