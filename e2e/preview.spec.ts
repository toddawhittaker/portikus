import { expect, type Page, test } from "@playwright/test";
import { createProject, createStudent, query, toast, workspacePath } from "./helpers";

/**
 * The Preview tab, the Running surface and the preview route a terminal
 * link lands on (SPEC.md §14.6, §14.8, §18.2, BROWSER-HANDLING.md §12, §15).
 *
 * The control plane's preview routes and the preview host itself are
 * answered by the browser's own network interception, so these tests cover
 * the browser behaviour whichever way the gateway is deployed.
 */

const PREVIEW_ORIGIN = "http://preview.test";
const BOOTSTRAP = `${PREVIEW_ORIGIN}/__portikus/bootstrap?t=ticket`;

interface Listener {
	port: number;
	command?: string;
	docker?: boolean;
	reachability?: "reachable" | "forwarded" | "denied" | "unknown";
}

function listeningBody(workspaceId: string, listeners: Listener[]) {
	return listeners.map((listener) => ({
		workspaceId,
		port: listener.port,
		addresses: ["0.0.0.0"],
		protocolHint: "http",
		process: { pid: 42, command: listener.command ?? "node" },
		...(listener.docker
			? { container: { id: "abc123", name: listener.command ?? "postgres" } }
			: {}),
		previewReachability: listener.reachability ?? "reachable",
		observedAt: new Date().toISOString(),
	}));
}

/**
 * Answer the preview routes and serve a tiny application on the preview
 * host, so the frame has something real to load.
 */
async function stubPreview(
	page: Page,
	workspaceId: string,
	listeners: Listener[],
	options: { grantStatus?: number; grantBody?: unknown } = {},
): Promise<{ grants: number }> {
	const counters = { grants: 0 };
	await page.route(`**/workspaces/${workspaceId}/listening`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(listeningBody(workspaceId, listeners)),
		}),
	);
	await page.route(`**/workspaces/${workspaceId}/preview-grants`, (route) => {
		counters.grants += 1;
		const status = options.grantStatus ?? 200;
		const body =
			options.grantBody ??
			(status === 200
				? {
						previewOrigin: PREVIEW_ORIGIN,
						bootstrapUrl: BOOTSTRAP,
						expiresAt: new Date(Date.now() + 30_000).toISOString(),
					}
				: { code: "FORBIDDEN", message: "You cannot preview this workspace." });
		return route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	await page.route(`${PREVIEW_ORIGIN}/**`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<html><body><h1 id=app>Hello from the workspace</h1></body></html>",
		}),
	);
	return counters;
}

async function openProject(page: Page, workspaceId: string) {
	const project = await createProject(workspaceId, { name: "todo-api" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	return project;
}

test.describe("application preview", () => {
	test("the Running surface lists ports and opens a preview", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [
			{ port: 5173, command: "node" },
			{ port: 5432, command: "postgres", docker: true },
		]);
		await openProject(page, student.workspaceId);

		await page.getByTestId("right-pane-running").click();
		await expect(page.getByTestId("running-row-5173")).toContainText("node");
		await expect(page.getByTestId("running-row-5432")).toContainText("Docker");

		await page.getByTestId("running-open-5173").click();
		const frame = page.getByTestId("preview-frame");
		await expect(frame).toHaveAttribute("src", BOOTSTRAP);
		await expect(page.getByTestId("preview-host")).toHaveText("preview.test");
		await expect(
			page.frameLocator("[data-testid=preview-frame]").locator("#app"),
		).toHaveText("Hello from the workspace");
	});

	test("an empty workspace says nothing is running yet", async ({ page, context }) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, []);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-running").click();
		await expect(page.getByText("Nothing is running yet")).toBeVisible();
	});

	test("the + Preview launcher opens a port the student names", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 4321 }]);
		await openProject(page, student.workspaceId);

		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-preview").click();
		await page.getByLabel("Port").fill("4321");
		await page.getByTestId("preview-open-port").click();
		await expect(page.getByTestId("preview-frame")).toHaveAttribute("src", BOOTSTRAP);
		await expect(page.getByTestId("tab-preview:4321")).toBeVisible();
	});

	test("the launcher refuses a reserved port", async ({ page, context }) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, []);
		await openProject(page, student.workspaceId);
		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-preview").click();
		await page.getByLabel("Port").fill("80");
		await page.getByTestId("preview-open-port").click();
		await expect(
			page.getByText(
				"Ports below 1024 are reserved. Run your application on a higher port.",
			),
		).toBeVisible();
		await expect(page.getByTestId("preview-frame")).toHaveCount(0);
	});

	test("a saved preview with nothing listening explains itself and retries", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const counters = await stubPreview(page, student.workspaceId, []);
		const project = await createProject(student.workspaceId, { name: "saved" });
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: "preview:5173", root: { type: "preview", port: 5173 } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("preview-inactive")).toHaveText(
			"Nothing is currently listening on port 5173. Start your application to reconnect this preview.",
			{ timeout: 15_000 },
		);
		expect(counters.grants).toBe(0);

		// Retry asks for a grant even while discovery says nothing is there,
		// because the student may know better than the last scan.
		await page.getByTestId("preview-retry").click();
		await expect(page.getByTestId("preview-frame")).toHaveAttribute("src", BOOTSTRAP);
	});

	test("the Running surface marks a saved preview that is no longer running", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 3000 }]);
		const project = await createProject(student.workspaceId, { name: "stale" });
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: "preview:5173", root: { type: "preview", port: 5173 } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("right-pane-running").click();
		await expect(page.getByTestId("running-stale-5173")).toContainText("not running", {
			timeout: 15_000,
		});
	});

	test("a refused grant says the student may not preview this workspace", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 5173 }], {
			grantStatus: 403,
		});
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-running").click();
		await page.getByTestId("running-open-5173").click();
		await expect(page.getByTestId("preview-unauthorized")).toBeVisible();
	});

	test("the preview route a terminal link uses opens a preview tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 5173 }]);
		const project = await createProject(student.workspaceId, { name: "linked" });
		// Where a click on `http://localhost:5173` in a terminal lands
		// (SPEC.md §14.9); the parser itself is covered by unit tests.
		await page.goto(`${workspacePath(student.workspaceId, project.id)}/preview/5173`);
		await expect(page.getByTestId("preview-frame")).toHaveAttribute("src", BOOTSTRAP, {
			timeout: 15_000,
		});
	});

	test("a preview tab is saved and comes back on a reload", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 5173 }]);
		const project = await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-running").click();
		await page.getByTestId("running-open-5173").click();
		await expect(page.getByTestId("preview-frame")).toBeVisible();
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: unknown }>(
						"select layout from projects where id = $1",
						[project.id],
					);
					return JSON.stringify(rows[0]?.layout ?? null);
				},
				{ timeout: 15_000 },
			)
			.toContain('"preview:5173"');

		await page.reload();
		await expect(page.getByTestId("tab-preview:5173")).toBeVisible({
			timeout: 15_000,
		});
	});

	test("the frame carries the sandbox and permissions policy the design fixes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 5173 }]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-running").click();
		await page.getByTestId("running-open-5173").click();
		const frame = page.getByTestId("preview-frame");
		await expect(frame).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
		);
		await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
		await expect(frame).toHaveAttribute(
			"allow",
			"clipboard-read 'none'; clipboard-write 'self'; camera 'none'; microphone 'none'; geolocation 'none'",
		);
	});

	test("a preview link is copied with the warning that sign-in is needed", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubPreview(page, student.workspaceId, [{ port: 5173 }]);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-running").click();
		await page.getByTestId("running-open-5173").click();
		await page.getByTestId("preview-copy").click();
		await expect(
			toast(page, "This link only works while you are signed in."),
		).toBeVisible();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toBe(PREVIEW_ORIGIN);
	});
});
