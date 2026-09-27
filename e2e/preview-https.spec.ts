import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";
import { API_ORIGIN, FAKE_AGENT_URL } from "./ports";

/**
 * A student application serving HTTPS (issue #283, step 2, ADR 0041). The
 * API answers `/preview/authorize` with the upstream and the trusted
 * `X-Portikus-Upstream-Scheme` header, and the gateway speaks TLS to the
 * workspace, with certificate checks off, only when that header says https.
 *
 * The fake agent runs a real HTTPS and WebSocket application and reports it
 * with the `https` hint the real agent's TLS probe would give it. Caddy does
 * not exist here, so small routes stand in for it as in preview.spec.ts:
 * reserved paths go to the API, everything else is authorized first and
 * then proxied to the upstream over the scheme the API named.
 */

// `ws` is a dependency of the API, not of the root; Node's own WebSocket
// cannot turn certificate checks off for the self-signed hop.
const WebSocketClient = createRequire(
	new URL("../apps/api/package.json", import.meta.url),
)("ws") as new (
	url: string,
	options: { rejectUnauthorized: boolean },
) => {
	on(event: "message", listener: (data: Buffer) => void): void;
	on(event: "open" | "close", listener: () => void): void;
	send(data: string): void;
	close(): void;
};

const PREVIEW_SUFFIX = ".preview.localhost";
const SCHEME_HEADER = "x-portikus-upstream-scheme";

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

/** One GET over TLS to a workspace upstream, certificate unchecked. */
function tlsGet(
	upstream: string,
	path: string,
	host: string,
): Promise<{ status: number; contentType?: string; body: Buffer }> {
	const [hostname, port] = upstream.split(":");
	return new Promise((resolve, reject) => {
		const outbound = httpsRequest(
			{
				host: hostname,
				port: Number(port),
				path,
				headers: { host },
				rejectUnauthorized: false,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 502,
						contentType: response.headers["content-type"],
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		outbound.on("error", reject);
		outbound.end();
	});
}

/**
 * Stand in for Caddy, for plain requests and WebSockets to preview hosts.
 * Returns the schemes the API named for each proxied request.
 */
async function previewGateway(page: Page): Promise<{ schemes: string[] }> {
	const seen = { schemes: [] as string[] };

	async function authorize(host: string, cookie: string) {
		return fetch(`${API_ORIGIN}/preview/authorize`, {
			headers: { "x-forwarded-host": host, "x-forwarded-proto": "https", cookie },
			redirect: "manual",
		});
	}

	/** Authorize, then reach the upstream the way the API says to. */
	async function proxy(host: string, path: string, cookie: string) {
		const answer = await authorize(host, cookie);
		if (!answer.ok) {
			return {
				status: answer.status,
				contentType: answer.headers.get("content-type") ?? undefined,
				body: Buffer.from(await answer.arrayBuffer()),
			};
		}
		const upstream = answer.headers.get("x-portikus-upstream");
		const scheme = answer.headers.get(SCHEME_HEADER);
		if (!upstream || !scheme) throw new Error("the authorization named no upstream");
		seen.schemes.push(scheme);
		if (scheme === "https") return tlsGet(upstream, path, host);
		const plain = await fetch(`http://${upstream}${path}`, { headers: { host } });
		return {
			status: plain.status,
			contentType: plain.headers.get("content-type") ?? undefined,
			body: Buffer.from(await plain.arrayBuffer()),
		};
	}

	await page.route(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const cookie = (await request.headerValue("cookie")) ?? "";
			let answer: { status: number; contentType?: string; body: Buffer };
			if (url.pathname.startsWith("/__portikus/")) {
				const boot = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
					headers: {
						"x-forwarded-host": url.host,
						"x-forwarded-proto": "https",
						cookie,
					},
					redirect: "manual",
				});
				const setCookie = boot.headers.getSetCookie();
				const location = boot.headers.get("location");
				if (boot.status !== 303 || location === null) {
					return route.fulfill({
						status: boot.status,
						body: Buffer.from(await boot.arrayBuffer()),
					});
				}
				// Follow the bootstrap redirect here, with the cookie it set.
				const minted = setCookie.map((line) => line.split(";")[0] ?? "").join("; ");
				answer = await proxy(
					url.host,
					location,
					[cookie, minted].filter(Boolean).join("; "),
				);
				return route.fulfill({
					status: answer.status,
					headers: {
						...(answer.contentType ? { "content-type": answer.contentType } : {}),
						...(setCookie.length > 0 ? { "set-cookie": setCookie.join("\n") } : {}),
					},
					body: answer.body,
				});
			}
			answer = await proxy(url.host, `${url.pathname}${url.search}`, cookie);
			return route.fulfill({
				status: answer.status,
				headers: answer.contentType ? { "content-type": answer.contentType } : {},
				body: answer.body,
			});
		},
	);

	await page.routeWebSocket(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (socket) => {
			const url = new URL(socket.url());
			const cookies = await page
				.context()
				.cookies(`https://${url.host}/`)
				.then((all) => all.map((one) => `${one.name}=${one.value}`).join("; "));
			const answer = await authorize(url.host, cookies);
			const upstream = answer.headers.get("x-portikus-upstream");
			const scheme = answer.headers.get(SCHEME_HEADER);
			if (!answer.ok || !upstream || !scheme) {
				socket.close({ code: 1008, reason: "not authorized" });
				return;
			}
			seen.schemes.push(scheme);
			const wsScheme = scheme === "https" ? "wss" : "ws";
			const server = new WebSocketClient(`${wsScheme}://${upstream}${url.pathname}`, {
				rejectUnauthorized: false,
			});
			const early: string[] = [];
			let open = false;
			server.on("open", () => {
				open = true;
				for (const message of early.splice(0)) server.send(message);
			});
			server.on("message", (data) => socket.send(data.toString()));
			server.on("close", () => socket.close());
			socket.onMessage((message) => {
				const text = message.toString();
				if (open) server.send(text);
				else early.push(text);
			});
			socket.onClose(() => server.close());
		},
	);

	return seen;
}

async function openProject(page: Page, workspaceId: string) {
	const project = await createProject(workspaceId, { name: "secure-app" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
}

/** Open the Preview tab on the HTTPS application. */
async function previewInTab(page: Page, workspaceId: string, port: number) {
	await openProject(page, workspaceId);
	await page.getByTestId("right-pane-tab-running").click();
	await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
}

test.describe("a preview of a port speaking HTTPS", () => {
	test("the Preview tab shows the HTTPS application", async ({ page, context }) => {
		const student = await createStudent(context);
		const seen = await previewGateway(page);
		const port = await startHttpsApp(student.workspaceId);
		await previewInTab(page, student.workspaceId, port);

		await expect(
			page.frameLocator("[data-testid=preview-frame]").locator("h1"),
		).toHaveText("Secure app", { timeout: 20_000 });
		await expect(page.getByTestId("preview-https")).toHaveCount(0);
		expect(seen.schemes).toContain("https");
		expect(seen.schemes).not.toContain("http");
	});

	test("the HTTPS preview has no axe violations", async ({ page, context }) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startHttpsApp(student.workspaceId);
		await previewInTab(page, student.workspaceId, port);
		await expect(
			page.frameLocator("[data-testid=preview-frame]").locator("h1"),
		).toHaveText("Secure app", { timeout: 20_000 });

		const results = await (await settledAxe(page))
			// WCAG rules only: the framed page is the student's, and axe's
			// best-practice rules would judge its missing landmarks.
			.withTags(WCAG_TAGS)
			.include(".pk-preview-body")
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});

	test("a new tab opens the application and its WebSocket over TLS", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const seen = await previewGateway(page);
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
		expect(response?.status()).toBe(200);
		await expect(page.locator("h1")).toHaveText("Secure app");

		// The application's own WebSocket, through the gateway to wss upstream.
		const messages = await page.evaluate(
			() =>
				new Promise<string[]>((resolve, reject) => {
					const scheme = location.protocol === "https:" ? "wss" : "ws";
					const socket = new WebSocket(`${scheme}://${location.host}/`);
					const got: string[] = [];
					socket.onmessage = (event) => {
						got.push(String(event.data));
						if (got.length === 1) socket.send("ping");
						if (got.length === 2) {
							socket.close();
							resolve(got);
						}
					};
					socket.onerror = () => reject(new Error("the WebSocket failed"));
				}),
		);
		expect(messages).toEqual(["hello", "echo:ping"]);
		expect(seen.schemes.every((scheme) => scheme === "https")).toBe(true);
	});
});
