import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	startPreviewApp,
	workspacePath,
} from "./helpers";
import { API_ORIGIN } from "./ports";
import { appFrameLocator, previewGateway } from "./preview-gateway";

/**
 * Previews on a different site from Portikus (BROWSER-HANDLING.md §7.2).
 *
 * Portikus runs on 127.0.0.1 and previews on `*.preview.localhost`. A browser
 * treats those as two sites: an IP address is a site of its own and shares
 * no registrable domain with any name. That is the layout of a deployment
 * whose preview suffix is a separate domain, such as an app host on
 * `kitestringlabs.org` with previews on `kitestringlabs.dev`.
 *
 * Unlike the other preview specs, the gateway here holds no cookies: the
 * browser stores and sends the preview cookie itself, so these tests show
 * that the partitioned cookie an embedded bootstrap sets is really kept
 * inside the Portikus page that framed it.
 */

const PREVIEW_SUFFIX = ".preview.localhost";

async function openRunning(page: Page, workspaceId: string, port: number) {
	const project = await createProject(workspaceId, { name: "cross-site" });
	await page.goto(workspacePath(workspaceId, project.id));
	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByTestId(`running-row-${port}`)).toBeVisible({
		timeout: 20_000,
	});
}

test("an embedded preview keeps its session across reloads", async ({
	page,
	context,
	browserName,
}) => {
	// WebKit in Playwright keeps no cookie set inside a cross-site frame,
	// partitioned or not; there the preview opens in its own tab instead.
	test.skip(
		browserName === "webkit",
		"WebKit refuses a cookie set in a cross-site frame",
	);
	const student = await createStudent(context);
	const counts = await previewGateway(context, { browserCookies: true });
	const port = await startPreviewApp(student.workspaceId, "Across sites");
	await openRunning(page, student.workspaceId, port);

	await page.getByTestId(`running-open-${port}`).click();
	const heading = appFrameLocator(page).locator("h1");
	await expect(heading).toHaveText("Across sites", { timeout: 20_000 });

	const host = new URL(
		page
			.frames()
			.find((one) => one.url().includes(PREVIEW_SUFFIX))
			?.url() ?? "",
	).host;
	const stored = (await context.cookies(`https://${host}/`)).find(
		(one) => one.name === "portikus-preview",
	);
	expect(stored?.sameSite).toBe("None");
	expect(stored?.secure).toBe(true);
	// Playwright's Chromium stores a Partitioned cookie without a partition
	// key, so that it is kept to the framing site is not checked here; real
	// Chrome and Safari partition it.

	const before = counts.app;
	await page.getByTestId("preview-reload").click();
	await expect(heading).toHaveText("Across sites", { timeout: 20_000 });
	await expect.poll(() => counts.app).toBeGreaterThan(before);
});

test("a browser that refuses the embedded cookie is told so and offered a tab", async ({
	page,
	context,
	browserName,
}) => {
	test.skip(
		browserName === "webkit",
		"WebKit refuses a cookie set in a cross-site frame",
	);
	const student = await createStudent(context);
	await previewGateway(context, { browserCookies: true, refusePartitioned: true });
	const port = await startPreviewApp(student.workspaceId, "Blocked here");
	await openRunning(page, student.workspaceId, port);

	await page.getByTestId(`running-open-${port}`).click();
	const frame = page.frameLocator("[data-testid=preview-frame]");
	await expect(
		frame.getByRole("heading", { name: "Preview blocked by your browser" }),
	).toBeVisible({ timeout: 20_000 });
	await expect(frame.getByText("Preview session ended")).toHaveCount(0);

	// The link is clicked inside the real sandboxed frame, so the tab it opens
	// inherits those flags. The frame does not let popups escape its sandbox.
	const sandbox = await page.getByTestId("preview-frame").getAttribute("sandbox");
	expect(sandbox).toContain("allow-popups");
	expect(sandbox).not.toContain("allow-popups-to-escape-sandbox");

	// The way out opens the same preview in a tab of its own.
	const opened = context.waitForEvent("page");
	await frame.getByRole("link", { name: "Open in new tab" }).click();
	const tab = await opened;
	await expect(tab.locator("h1")).toHaveText("Blocked here", { timeout: 20_000 });
	expect(new URL(tab.url()).host).toContain(PREVIEW_SUFFIX);
});

test("a preview in its own tab still works", async ({ page, context, browserName }) => {
	const student = await createStudent(context);
	// A WebKit route never sees the request's cookies, so there the edge
	// holds the session as in the other preview specs.
	await previewGateway(context, { browserCookies: browserName !== "webkit" });
	const port = await startPreviewApp(student.workspaceId, "Own tab");
	await openRunning(page, student.workspaceId, port);

	const opened = context.waitForEvent("page");
	await page.getByTestId(`running-new-tab-${port}`).click();
	const tab = await opened;
	await expect(tab.locator("h1")).toHaveText("Own tab", { timeout: 20_000 });
	const stored = (await context.cookies(tab.url())).find(
		(one) => one.name === "portikus-preview",
	);
	expect(stored?.sameSite).toBe("Strict");
	expect(stored?.partitionKey).toBeFalsy();

	await tab.goto(new URL("/", tab.url()).href);
	await expect(tab.locator("h1")).toHaveText("Own tab", { timeout: 20_000 });
});

/** What the real preview server saw of one request. */
interface Seen {
	path: string;
	cookie: string;
	site: string | undefined;
}

/** A self-signed certificate for the preview hosts, made for this run. */
function previewCertificate(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), "portikus-e2e-preview-tls-"));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"1",
			"-subj",
			`/CN=*${PREVIEW_SUFFIX}`,
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ stdio: "ignore" },
	);
	return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * A real HTTPS server standing in for Caddy on the preview hosts. Unlike a
 * route handler, the browser's own cookie rules decide what reaches it,
 * which is the thing under test: a route cannot see whether a cookie would
 * have been sent.
 */
async function previewServer(): Promise<{
	server: Server;
	port: number;
	seen: Seen[];
}> {
	const seen: Seen[] = [];
	const server = createServer(previewCertificate(), async (request, response) => {
		const path = request.url ?? "/";
		const host = (request.headers.host ?? "").split(":")[0] ?? "";
		const cookie = request.headers.cookie ?? "";
		const site = request.headers["sec-fetch-site"] as string | undefined;
		seen.push({ path, cookie, site });
		const forwarded: Record<string, string> = {
			"x-forwarded-host": host,
			"x-forwarded-proto": "https",
			cookie,
			...(site ? { "sec-fetch-site": site } : {}),
		};
		const dest = request.headers["sec-fetch-dest"];
		if (typeof dest === "string") forwarded["sec-fetch-dest"] = dest;
		let answer: Response;
		if (path.startsWith("/__portikus/")) {
			answer = await fetch(`${API_ORIGIN}${path}`, {
				headers: forwarded,
				redirect: "manual",
			});
		} else {
			answer = await fetch(`${API_ORIGIN}/preview/authorize`, {
				headers: { ...forwarded, "x-forwarded-method": "GET", "x-forwarded-uri": path },
				redirect: "manual",
			});
			const upstream = answer.headers.get("x-portikus-upstream");
			if (answer.ok && upstream) {
				answer = await fetch(`http://${upstream}${path}`, { headers: { host } });
			}
		}
		const headers: Record<string, string | string[]> = {};
		for (const name of [
			"content-type",
			"cache-control",
			"referrer-policy",
			"content-security-policy",
			"location",
		]) {
			const value = answer.headers.get(name);
			if (value !== null) headers[name] = value;
		}
		const setCookie = answer.headers.getSetCookie();
		if (setCookie.length > 0) headers["set-cookie"] = setCookie;
		response.writeHead(answer.status, headers);
		response.end(Buffer.from(await answer.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as AddressInfo).port, seen };
}

test.describe("a tab preview served by a real preview host", () => {
	// Chromium alone is asked to accept the throwaway certificate here; the
	// redirect-chain rule this pins is Chromium's.
	test.use({ ignoreHTTPSErrors: true });

	test("its first load carries the strict cookie its bootstrap set", async ({
		page,
		context,
		browserName,
	}) => {
		test.skip(
			browserName !== "chromium",
			"the throwaway certificate is set up for Chromium",
		);
		const { server, port: serverPort, seen } = await previewServer();
		try {
			const student = await createStudent(context);
			const port = await startPreviewApp(student.workspaceId, "Real host");
			await openRunning(page, student.workspaceId, port);
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
			const served = new URL(bootstrapUrl);
			served.port = String(serverPort);

			// A link on the Portikus page, so the navigation starts cross-site as
			// "Open in new tab" does.
			await page.evaluate((href) => {
				const link = document.createElement("a");
				link.href = href;
				link.textContent = "open the preview";
				link.id = "real-preview-link";
				document.body.append(link);
			}, served.href);
			await page.locator("#real-preview-link").click();

			await expect(page.locator("h1")).toHaveText("Real host", { timeout: 20_000 });
			const boot = seen.find((one) => one.path.startsWith("/__portikus/bootstrap"));
			expect(boot?.site).toBe("cross-site");
			const first = seen.find((one) => one.path === "/");
			expect(first?.cookie).toContain("portikus-preview=");
			const stored = (await context.cookies(page.url())).find(
				(one) => one.name === "portikus-preview",
			);
			expect(stored?.sameSite).toBe("Strict");
		} finally {
			server.close();
		}
	});
});
