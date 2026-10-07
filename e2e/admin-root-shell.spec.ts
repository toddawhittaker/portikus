/**
 * The admin Root shell tab (ADR 0051): shells in split panes, the banner,
 * an exit closing its pane, and the session-ended, socket-cap and refused
 * states. playwright.config.ts runs a fake helper that echoes input,
 * reports each resize as "[resized CxR]", and ends on the line `exit`.
 */
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	API_ORIGIN,
	createSignedInUser,
	createStudent,
	deleteSessions,
	query,
	routeApi,
	WEB_ORIGIN,
} from "./helpers";

const PROMPT = "root@fake:~#";

/** A fresh administrator of this test's own, so the socket cap and sessions are not shared. */
async function openRootShellTab(page: Page): Promise<string> {
	const { userId } = await createSignedInUser(page.context(), "administrator");
	await page.goto("/admin/shell");
	await expect(page.getByRole("heading", { level: 2, name: "Root shell" })).toBeVisible(
		{
			timeout: 15_000,
		},
	);
	return userId;
}

function panes(page: Page): Locator {
	return page.locator('.pk-termgroup:not([hidden]) [data-testid^="terminal-leaf-"]');
}

async function paneIds(page: Page): Promise<string[]> {
	const ids = await panes(page).evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-testid") ?? ""),
	);
	return ids.map((id) => id.replace("terminal-leaf-", ""));
}

function rowsOf(page: Page, shellId: string): Locator {
	return page.locator(`[data-testid=terminal-pane-${shellId}] .xterm-rows`);
}

/** Open the first shell and wait for its prompt. */
async function openShell(page: Page): Promise<string> {
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(page.getByRole("tab", { name: "Root shell 1" })).toBeVisible();
	const [id] = await paneIds(page);
	if (!id) throw new Error("no root shell pane");
	await expect(rowsOf(page, id)).toContainText(PROMPT, { timeout: 15_000 });
	return id;
}

/** Type a line once the shell is connected and its input has the keyboard. */
async function typeLine(page: Page, shellId: string, text: string): Promise<void> {
	const pane = page.getByTestId(`terminal-pane-${shellId}`);
	await expect(pane).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
	await pane.locator(".xterm-screen").click();
	await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
	await page.keyboard.insertText(text);
	await page.keyboard.press("Enter");
}

test("an administrator opens a root shell, types, splits, resizes and exits", async ({
	page,
}) => {
	await openRootShellTab(page);
	await expect(page.getByTestId("admin-tab-shell")).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(page.getByTestId("root-shell-banner")).toContainText(
		"Root on this server.",
	);
	// Nothing opens on its own: each shell is an audited sign-in.
	await expect(page.getByText("No root shells open")).toBeVisible();

	const first = await openShell(page);
	await typeLine(page, first, "echo hello-root");
	await expect(rowsOf(page, first)).toContainText("echo hello-root");

	await page.getByTestId(`terminal-actions-${first}`).click();
	await page.getByTestId("split-right").click();
	await expect(panes(page)).toHaveCount(2);
	const second = (await paneIds(page)).find((id) => id !== first);
	if (!second) throw new Error("the split made no second pane");
	await expect(rowsOf(page, second)).toContainText(PROMPT, { timeout: 15_000 });
	await expect(page.locator(".pk-termgroup:not([hidden]) .pk-split")).toHaveAttribute(
		"data-direction",
		"row",
	);

	// A narrower window sends a settled size, which the helper reports.
	const size = page.viewportSize();
	await page.setViewportSize({ width: (size?.width ?? 1280) - 200, height: 720 });
	await expect(rowsOf(page, first)).toContainText(/\[resized \d+x\d+\]/);

	// The second shell's input is its own.
	await typeLine(page, second, "only-in-second");
	await expect(rowsOf(page, second)).toContainText("only-in-second");
	await expect(rowsOf(page, first)).not.toContainText("only-in-second");

	await typeLine(page, second, "exit");
	await expect(panes(page)).toHaveCount(1);
	await expect(page.getByTestId(`terminal-leaf-${second}`)).toHaveCount(0);

	await typeLine(page, first, "exit");
	await expect(page.getByRole("tab", { name: "Root shell 1" })).toHaveCount(0);
	await expect(page.getByText("No root shells open")).toBeVisible();
});

test("the heading and warning share one short row, with Help and no About box", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openRootShellTab(page);
	const banner = page.getByTestId("root-shell-banner");
	const help = banner.getByRole("link", { name: "Help (opens in a new tab)" });
	await expect(help).toHaveAttribute("href", "/admin/help#admin-shell");
	await expect(help).toHaveAttribute("target", "_blank");
	await expect(page.getByTestId("intro-admin-shell")).toHaveCount(0);

	// One line of warning beside the heading leaves the panes the rest of the frame.
	const heading = await page
		.getByRole("heading", { level: 2, name: "Root shell" })
		.boundingBox();
	const strip = await banner.boundingBox();
	const head = await page.locator(".pk-rootshell-head").boundingBox();
	if (!heading || !strip || !head) throw new Error("the Root shell header has no box");
	expect(strip.x).toBeGreaterThan(heading.x + heading.width);
	expect(strip.height).toBeLessThan(48);
	expect(head.height).toBeLessThan(72);

	// At the smallest admin window (SPEC.md section 20.1) the warning wraps inside the frame.
	await page.setViewportSize({ width: 768, height: 720 });
	await expect(async () => {
		const frame = await page.getByTestId("admin-frame").boundingBox();
		const narrow = await banner.boundingBox();
		const narrowHead = await page.locator(".pk-rootshell-head").boundingBox();
		if (!frame || !narrow || !narrowHead)
			throw new Error("the Root shell header has no box");
		expect(narrow.x + narrow.width).toBeLessThanOrEqual(frame.x + frame.width);
		expect(narrowHead.height).toBeLessThan(120);
	}).toPass();
});

test("a shell keeps running while another admin tab is shown", async ({ page }) => {
	await openRootShellTab(page);
	const id = await openShell(page);
	const mountId = await page
		.getByTestId(`terminal-leaf-${id}`)
		.getAttribute("data-mount-id");

	await page.getByTestId("admin-tab-settings").click();
	await expect(page.getByTestId("root-shell-area")).toBeHidden();
	await page.getByTestId("admin-tab-shell").click();

	await expect(page.getByTestId(`terminal-leaf-${id}`)).toHaveAttribute(
		"data-mount-id",
		mountId ?? "",
	);
	await typeLine(page, id, "still-here");
	await expect(rowsOf(page, id)).toContainText("still-here");
});

test("a pane dragged onto the tab strip gets a tab of its own", async ({ page }) => {
	await openRootShellTab(page);
	const first = await openShell(page);
	await page.getByTestId(`terminal-actions-${first}`).click();
	await page.getByTestId("split-down").click();
	await expect(panes(page)).toHaveCount(2);
	const second = (await paneIds(page)).find((id) => id !== first);
	if (!second) throw new Error("the split made no second pane");

	const handle = await page.getByTestId(`terminal-handle-${second}`).boundingBox();
	const strip = await page.getByTestId("root-shell-tabs").boundingBox();
	if (!handle || !strip) throw new Error("nothing to drag");
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	const to = { x: strip.x + strip.width - 40, y: strip.y + strip.height / 2 };
	await page.mouse.move(to.x, to.y, { steps: 12 });
	// dnd-kit reports the target of the move before, and the strip is only
	// one step tall on the way up, so move within it once more.
	await page.mouse.move(to.x - 10, to.y, { steps: 2 });
	await expect(page.getByTestId("pane-drag-overlay")).toBeVisible();
	await expect(page.getByTestId("tab-insert-marker")).toBeVisible();
	await page.mouse.up();

	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.getByRole("tab", { name: "Root shell 2" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	// Moved, not reconnected: the same shell answers.
	await typeLine(page, second, "after-move");
	await expect(rowsOf(page, second)).toContainText("after-move");
});

test("a revoked session ends the shells and goes to the session-ended page", async ({
	page,
}) => {
	const userId = await openRootShellTab(page);
	await openShell(page);
	await deleteSessions(userId);
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible({
		timeout: 20_000,
	});
	await expect(page).toHaveURL(/\/session-ended$/);
});

test("the socket cap says what to do, and the pane stays", async ({ page }) => {
	await page.routeWebSocket(/\/admin\/root-shell\/ws/, (socket) => {
		socket.close({ code: 4429 });
	});
	await openRootShellTab(page);
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(panes(page)).toHaveCount(1);
	const [id] = await paneIds(page);
	await expect(page.getByTestId(`root-shell-lost-${id}`)).toContainText(
		"You have too many terminals open",
	);
	await expect(page.getByTestId(`terminal-leaf-${id}`)).toBeVisible();
});

test("a shell the host refused says so, and Try again opens it", async ({ page }) => {
	// Refused until the test says otherwise: a development build mounts the
	// pane twice, so counting attempts would not work.
	let refuse = true;
	await page.routeWebSocket(/\/admin\/root-shell\/ws/, (socket) => {
		if (refuse) {
			socket.close({ code: 1000 });
			return;
		}
		socket.connectToServer();
	});
	await openRootShellTab(page);
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(panes(page)).toHaveCount(1);
	const [id] = await paneIds(page);
	await expect(page.getByTestId(`root-shell-refused-${id}`)).toContainText(
		"The root shell could not start on the host.",
	);
	refuse = false;
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(rowsOf(page, id ?? "")).toContainText(PROMPT, { timeout: 15_000 });
});

test("students see no Root shell tab and the API refuses them", async ({
	page,
	context,
}) => {
	await createStudent(context);
	await page.goto("/admin/shell");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
	await expect(page.getByTestId("admin-tab-shell")).toHaveCount(0);

	const status = await page.request.get(`${API_ORIGIN}/admin/root-shell`);
	expect(status.status()).toBe(403);

	// A real upgrade with the student's cookie and an allowed Origin is
	// refused with 403 before any socket opens; the API's own matrix,
	// apps/api/src/security/ws-authz-matrix.test.ts, pins every role.
	const cookie = (await context.cookies(WEB_ORIGIN))
		.map((item) => `${item.name}=${item.value}`)
		.join("; ");
	expect(await upgradeStatus(cookie)).toBe(403);

	// And the browser's own attempt never opens.
	const outcome = await page.evaluate(
		() =>
			new Promise<string>((resolve) => {
				const scheme = location.protocol === "https:" ? "wss" : "ws";
				const socket = new WebSocket(
					`${scheme}://${location.host}/admin/root-shell/ws?cols=80&rows=24`,
				);
				socket.onopen = () => resolve("open");
				socket.onclose = (event) => resolve(`closed ${event.code}`);
			}),
	);
	expect(outcome).not.toBe("open");
});

/** The HTTP status the API answers a WebSocket upgrade to the root-shell socket with. */
function upgradeStatus(cookie: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(`${API_ORIGIN}/admin/root-shell/ws?cols=80&rows=24`, {
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": randomBytes(16).toString("base64"),
				origin: WEB_ORIGIN,
				cookie,
			},
		});
		request.on("response", (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.on("upgrade", (_response, socket) => {
			socket.destroy();
			resolve(101);
		});
		request.on("error", reject);
		request.end();
	});
}

test("an administrator demoted while a shell is open goes to the not-authorized page", async ({
	page,
}) => {
	const userId = await openRootShellTab(page);
	await openShell(page);
	await query("update users set role = 'student' where id = $1", [userId]);
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 20_000 });
});

test("an administrator signed out before a shell opens goes to the session-ended page", async ({
	page,
}) => {
	const userId = await openRootShellTab(page);
	await deleteSessions(userId);
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(page).toHaveURL(/\/session-ended$/, { timeout: 15_000 });
});

test("an administrator demoted before a shell opens goes to the not-authorized page", async ({
	page,
}) => {
	const userId = await openRootShellTab(page);
	await query("update users set role = 'student' where id = $1", [userId]);
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
});

test("with root shells off the tab is hidden and its address says so", async ({
	page,
}) => {
	await routeApi(page, "**/admin/root-shell", (route) =>
		route.fulfill({ json: { enabled: false } }),
	);
	await openRootShellTab(page);
	await expect(page.getByTestId("admin-tab-shell")).toHaveCount(0);
	await expect(page.getByTestId("admin-tab-settings")).toBeVisible();
	await expect(page.getByTestId("root-shell-off")).toContainText(
		"Root shells are turned off on this server",
	);
});
