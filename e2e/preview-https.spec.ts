import { expect, type Page, test } from "@playwright/test";
import { createProject, createStudent, settledAxe, workspacePath } from "./helpers";
import { API_ORIGIN, FAKE_AGENT_URL } from "./ports";

/**
 * A student application serving HTTPS (issue #283, step 1). The preview
 * gateway speaks plain HTTP to the workspace, so the API answers such a port
 * with a Portikus page and the Preview tab says the same thing instead of
 * showing a broken frame (SPEC.md §14.5, BROWSER-HANDLING.md §10).
 *
 * The fake agent runs a real HTTPS application and reports it with the
 * `https` hint the real agent's TLS probe would give it. As in
 * preview.spec.ts, Caddy does not exist here, so a small route stands in for
 * it: reserved paths go to the API, everything else is authorized by
 * `/preview/authorize`, and a refusal's page is passed straight through.
 */

const PREVIEW_SUFFIX = ".preview.localhost";

const HTTPS_SENTENCE =
	"This port is speaking HTTPS; the preview expects plain HTTP. Start your " +
	"server without TLS, or wait for HTTPS previews.";

/** Start an HTTPS application inside the fake agent and report it listening. */
async function startHttpsApp(workspaceId: string): Promise<number> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/app`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, title: "Secure app", https: true }),
	});
	if (!response.ok) {
		throw new Error(`the fake agent refused to start an app: ${response.status}`);
	}
	return ((await response.json()) as { port: number }).port;
}

/**
 * Stand in for Caddy. Returns how many requests the API authorized, which
 * must stay zero: an HTTPS port is never proxied.
 */
async function previewGateway(page: Page): Promise<{ authorized: number }> {
	const counts = { authorized: 0 };

	async function authorize(host: string, cookie: string) {
		const answer = await fetch(`${API_ORIGIN}/preview/authorize`, {
			headers: { "x-forwarded-host": host, "x-forwarded-proto": "https", cookie },
			redirect: "manual",
		});
		if (answer.ok) counts.authorized += 1;
		return answer;
	}

	await page.route(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const cookie = (await request.headerValue("cookie")) ?? "";
			let answer: Response;
			if (url.pathname.startsWith("/__portikus/")) {
				const boot = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
					headers: {
						"x-forwarded-host": url.host,
						"x-forwarded-proto": "https",
						cookie,
					},
					redirect: "manual",
				});
				// Follow the bootstrap redirect here, with the cookie it set.
				const minted = boot.headers
					.getSetCookie()
					.map((line) => line.split(";")[0] ?? "")
					.filter(Boolean)
					.join("; ");
				answer =
					boot.status === 303
						? await authorize(url.host, [cookie, minted].filter(Boolean).join("; "))
						: boot;
			} else {
				answer = await authorize(url.host, cookie);
			}
			const contentType = answer.headers.get("content-type");
			return route.fulfill({
				status: answer.status,
				headers: contentType ? { "content-type": contentType } : {},
				body: Buffer.from(await answer.arrayBuffer()),
			});
		},
	);
	return counts;
}

async function openProject(page: Page, workspaceId: string) {
	const project = await createProject(workspaceId, { name: "secure-app" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
}

test.describe("a preview of a port speaking HTTPS", () => {
	test("the Preview tab explains the port speaks HTTPS", async ({ page, context }) => {
		const student = await createStudent(context);
		const port = await startHttpsApp(student.workspaceId);
		await openProject(page, student.workspaceId);

		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });

		await expect(page.getByTestId("preview-https")).toHaveText(HTTPS_SENTENCE, {
			timeout: 20_000,
		});
		await expect(
			page.getByText(`Port ${port} is speaking HTTPS`).first(),
		).toBeVisible();
		await expect(page.getByTestId("preview-frame")).toHaveCount(0);
	});

	test("the HTTPS notice has no axe violations", async ({ page, context }) => {
		const student = await createStudent(context);
		const port = await startHttpsApp(student.workspaceId);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(page.getByTestId("preview-https")).toBeVisible({ timeout: 20_000 });

		const results = await (await settledAxe(page))
			.include(".pk-preview-body")
			.analyze();
		expect(results.violations).toEqual([]);
	});

	test("the preview host answers with the Portikus page", async ({ page, context }) => {
		const student = await createStudent(context);
		const counts = await previewGateway(page);
		const port = await startHttpsApp(student.workspaceId);
		await openProject(page, student.workspaceId);
		// The Running pane showing the port means the API's registry has it.
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId(`running-row-${port}`)).toBeVisible({
			timeout: 20_000,
		});

		// A top-level grant, as "Open in new tab" asks for one.
		const bootstrapUrl = await page.evaluate(
			async ({ workspaceId, port }) => {
				const response = await fetch(`/workspaces/${workspaceId}/preview-grants`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ port, presentation: "top-level" }),
				});
				return ((await response.json()) as { bootstrapUrl: string }).bootstrapUrl;
			},
			{ workspaceId: student.workspaceId, port },
		);

		const response = await page.goto(bootstrapUrl);
		expect(response?.status()).toBe(503);
		await expect(page.locator("h1")).toHaveText(`Port ${port} is speaking HTTPS`);
		await expect(page.locator("p")).toHaveText(HTTPS_SENTENCE);
		expect(counts.authorized).toBe(0);
	});
});
