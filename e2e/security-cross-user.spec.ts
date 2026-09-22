import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	newTerminal,
	query,
	seedFile,
	startPreviewApp,
	type TestStudent,
	terminalIds,
	WEB_ORIGIN,
	waitForSavedLeaf,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * What another student and an administrator see of student A's workspace in
 * a real browser (Epic 12a, Done item 10; SPEC.md §5.2, §20.2, §24.3). The
 * API refuses these callers with 404; these tests check that the page built
 * on those answers shows nothing of A's terminals, files, previews, or
 * project names, and that A's preview host shows a Portikus refusal.
 */

const API_ORIGIN = "http://127.0.0.1:3000";
const PREVIEW_SUFFIX = ".preview.localhost";

const PROJECT_NAME = "Zanzibar Secret Project";
const FILE_NAME = "confidential-notes.md";
const FILE_TEXT = "the-private-contents-of-a-file";

interface Seeded {
	student: TestStudent;
	projectId: string;
	terminalId: string;
	port: number;
	label: string;
}

/**
 * Give student A a project with a file tab, a preview tab and a live
 * terminal, the way A would leave it after a session of work.
 */
async function seedStudentA(context: BrowserContext): Promise<Seeded> {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: PROJECT_NAME });
	await seedFile(student.workspaceId, project.slug, FILE_NAME, FILE_TEXT);
	const port = await startPreviewApp(student.workspaceId, "A private app");
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: [
				{ id: `file:${FILE_NAME}`, root: { type: "file", path: FILE_NAME } },
				{ id: `preview:${port}`, root: { type: "preview", port } },
			],
		}),
	]);

	const page = await context.newPage();
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId(`file-pane-${FILE_NAME}`)).toBeVisible({
		timeout: 15_000,
	});
	await newTerminal(page);
	await expect
		.poll(() => terminalIds(student.workspaceId, project.id), { timeout: 15_000 })
		.toHaveLength(1);
	const [terminalId] = await terminalIds(student.workspaceId, project.id);
	if (!terminalId) throw new Error("A's terminal was not created");
	await waitForSavedLeaf(project.id, terminalId);
	await page.close();

	const [row] = await query<{ label: string }>(
		"select label from workspaces where id = $1",
		[student.workspaceId],
	);
	if (!row) throw new Error("A's workspace row is missing");
	return { student, projectId: project.id, terminalId, port, label: row.label };
}

/** Open A's project page and wait until the page has asked for its projects. */
async function visitAsOther(page: Page, a: Seeded): Promise<void> {
	const projects = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
			`/workspaces/${a.student.workspaceId}/projects`,
		{ timeout: 20_000 },
	);
	await page.goto(workspacePath(a.student.workspaceId, a.projectId));
	expect((await projects).status()).toBe(404);
	// Give anything that would render late a moment to appear.
	await page.waitForTimeout(1_000);
}

/** Nothing of A's work is on screen. */
async function expectNothingOfA(page: Page, a: Seeded): Promise<void> {
	await expect(workTabs(page).getByRole("tab")).toHaveCount(0);
	await expect(page.getByTestId(`terminal-pane-${a.terminalId}`)).toHaveCount(0);
	await expect(page.locator(".xterm")).toHaveCount(0);
	await expect(page.getByTestId(`file-pane-${FILE_NAME}`)).toHaveCount(0);
	await expect(page.getByTestId("preview-frame")).toHaveCount(0);
	const text = (await page.locator("body").textContent()) ?? "";
	expect(text).not.toContain(PROJECT_NAME);
	expect(text).not.toContain(FILE_NAME);
	expect(text).not.toContain(FILE_TEXT);
	expect(text).not.toContain(`${a.label}-${a.port}`);
}

/** Make a signed-in administrator in this context. */
async function createAdministrator(context: BrowserContext): Promise<TestStudent> {
	const admin = await createStudent(context);
	await query("update users set role = 'administrator' where id = $1", [admin.userId]);
	return admin;
}

test.describe("another user in the browser", () => {
	test("student B's browser shows nothing of A's workspace", async ({ browser }) => {
		const owner = await browser.newContext({ baseURL: WEB_ORIGIN });
		const a = await seedStudentA(owner);
		await owner.close();

		const other = await browser.newContext({ baseURL: WEB_ORIGIN });
		try {
			await createStudent(other);
			const page = await other.newPage();
			await visitAsOther(page, a);
			await expectNothingOfA(page, a);

			// Direct requests from B's browser get the same 404s.
			const id = a.student.workspaceId;
			for (const path of [
				`/workspaces/${id}`,
				`/workspaces/${id}/terminals`,
				`/workspaces/${id}/projects/${a.projectId}/file?path=${FILE_NAME}`,
				`/workspaces/${id}/listening`,
			]) {
				const response = await page.request.get(path);
				expect(response.status(), path).toBe(404);
				expect(await response.text(), path).not.toContain(PROJECT_NAME);
			}
			const grant = await page.request.post(`/workspaces/${id}/preview-grants`, {
				headers: { origin: WEB_ORIGIN },
				data: { port: a.port, presentation: "embedded" },
			});
			expect(grant.status()).toBe(404);
		} finally {
			await other.close();
		}
	});

	test("an administrator's browser shows no terminals or files of A", async ({
		browser,
	}) => {
		const owner = await browser.newContext({ baseURL: WEB_ORIGIN });
		const a = await seedStudentA(owner);
		await owner.close();

		const adminContext = await browser.newContext({ baseURL: WEB_ORIGIN });
		try {
			await createAdministrator(adminContext);
			const page = await adminContext.newPage();
			await visitAsOther(page, a);
			await expectNothingOfA(page, a);

			const id = a.student.workspaceId;
			// The administrator may see the workspace itself (SPEC.md §20.2)...
			expect((await page.request.get(`/workspaces/${id}`)).status()).toBe(200);
			// ...but not what is inside it.
			for (const path of [
				`/workspaces/${id}/terminals`,
				`/workspaces/${id}/projects`,
				`/workspaces/${id}/projects/${a.projectId}/file?path=${FILE_NAME}`,
			]) {
				expect((await page.request.get(path)).status(), path).toBe(404);
			}
		} finally {
			await adminContext.close();
		}
	});

	test("A's preview host shows B a Portikus refusal", async ({ browser }) => {
		const owner = await browser.newContext({ baseURL: WEB_ORIGIN });
		const a = await seedStudentA(owner);

		// A opens the preview, so a live preview session exists for that host.
		const grant = await owner.request.post(
			`/workspaces/${a.student.workspaceId}/preview-grants`,
			{
				headers: { origin: WEB_ORIGIN },
				data: { port: a.port, presentation: "top-level" },
			},
		);
		expect(grant.status()).toBe(201);
		const { bootstrapUrl, previewOrigin } = (await grant.json()) as {
			bootstrapUrl: string;
			previewOrigin: string;
		};
		const host = new URL(previewOrigin).host;
		expect(new URL(previewOrigin).hostname.endsWith(PREVIEW_SUFFIX)).toBe(true);
		const ticketPath = new URL(bootstrapUrl);
		const bootstrap = await fetch(
			`${API_ORIGIN}${ticketPath.pathname}${ticketPath.search}`,
			{
				headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" },
				redirect: "manual",
			},
		);
		expect(bootstrap.status).toBe(303);
		await owner.close();

		const other = await browser.newContext({ baseURL: WEB_ORIGIN });
		try {
			await createStudent(other);
			const reachedApp: string[] = [];
			// Stand in for Caddy, as preview.spec.ts does: reserved paths go to
			// the API, everything else is authorized before it is proxied.
			await other.route(
				(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
				async (route) => {
					const url = new URL(route.request().url());
					const cookie = (await route.request().headerValue("cookie")) ?? "";
					const path = `${url.pathname}${url.search}`;
					const forwarded = {
						"x-forwarded-host": url.host,
						"x-forwarded-proto": "https",
						cookie,
					};
					const target = url.pathname.startsWith("/__portikus/")
						? `${API_ORIGIN}${path}`
						: `${API_ORIGIN}/preview/authorize`;
					const answer = await fetch(target, {
						headers: forwarded,
						redirect: "manual",
					});
					if (answer.ok && !url.pathname.startsWith("/__portikus/")) {
						reachedApp.push(path);
					}
					return route.fulfill({
						status: answer.status,
						headers: {
							"content-type": answer.headers.get("content-type") ?? "text/plain",
						},
						body: Buffer.from(await answer.arrayBuffer()),
					});
				},
			);
			const page = await other.newPage();

			const direct = await page.goto(`https://${host}/`);
			expect(direct?.status()).toBeGreaterThanOrEqual(400);
			await expect(page.locator("h1")).toHaveText(
				/Preview session ended|Preview not available/,
			);
			await expect(page.locator("body")).not.toContainText("A private app");

			// A's ticket, already used, is refused when replayed by B.
			const replay = await page.goto(bootstrapUrl);
			expect(replay?.status()).toBe(403);
			await expect(page.locator("h1")).toHaveText("Preview not available");

			expect(reachedApp).toEqual([]);
		} finally {
			await other.close();
		}
	});
});
