import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createLocalPasswordAdmin,
	expectNoViolations,
	loginAs,
	routeApi,
} from "./helpers";

/**
 * Switching between a tall and a short admin tab or Settings section must not
 * move the content sideways (SPEC.md sections 20.1 and 25.8). Headless
 * Chromium hides scrollbars, which hides the bug; these tests show them.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Every admin tab. Audit filtered to a workspace with no events is always short. */
const ADMIN_PATHS = [
	"/admin/users",
	"/admin/health",
	"/admin/logs",
	`/admin/audit?workspace=${randomUUID()}`,
	"/admin/network",
	"/admin/backups",
	"/admin/image",
	"/admin/certificate",
	"/admin/docker",
	"/admin/settings",
];

interface Frame {
	left: number;
	right: number;
	clientWidth: number;
	overflows: boolean;
}

/** The scroll box's inner width and the content column's edges, once loading is done. */
async function measure(scroller: Locator, content: Locator): Promise<Frame> {
	await expect(scroller.locator("[aria-busy=true]")).toHaveCount(0, {
		timeout: 15_000,
	});
	await expect(scroller.locator(".pk-skel")).toHaveCount(0, { timeout: 15_000 });
	const box = await content.boundingBox();
	if (!box) throw new Error("the content has no box");
	const { clientWidth, overflows } = await scroller.evaluate((el) => ({
		clientWidth: el.clientWidth,
		overflows: el.scrollHeight > el.clientHeight,
	}));
	return { left: box.x, right: box.x + box.width, clientWidth, overflows };
}

for (const viewport of [
	{ width: 1920, height: 1080 },
	{ width: 1280, height: 800 },
]) {
	test(`admin tabs keep the same width whether or not they scroll, at ${viewport.width}×${viewport.height}`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await loginAs(page, "carol");
		const frames: Record<string, Frame> = {};
		for (const path of ADMIN_PATHS) {
			await page.goto(path);
			const main = page.getByTestId("page-admin");
			await expect(main.getByRole("heading", { level: 2 }).first()).toBeVisible({
				timeout: 15_000,
			});
			frames[path] = await measure(main, page.getByTestId("admin-content"));
		}

		const all = Object.values(frames);
		// The check means something only if both kinds of tab were seen.
		expect(all.some((frame) => frame.overflows)).toBe(true);
		expect(all.some((frame) => !frame.overflows)).toBe(true);
		const edges = ({ left, right, clientWidth }: Frame) => ({
			left,
			right,
			clientWidth,
		});
		const first = edges(all[0] as Frame);
		for (const [path, frame] of Object.entries(frames)) {
			expect({ path, ...edges(frame) }).toEqual({ path, ...first });
		}
	});
}

async function openSettings(page: Page): Promise<Locator> {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	return dialog;
}

/** The scrolling pane that holds the open section, and that section's h2. */
async function settingsFrame(dialog: Locator, name: string) {
	const heading = dialog.getByRole("heading", { level: 2, name, exact: true });
	await expect(heading).toBeVisible();
	const pane = heading.locator("xpath=../..");
	const frame = await measure(pane, heading);
	return {
		clientWidth: frame.clientWidth,
		left: frame.left,
		overflows: frame.overflows,
	};
}

test("Settings sections keep the same pane width whether or not they scroll", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await createLocalPasswordAdmin(context, {
		prefix: "gutter",
		displayName: "Gutter Local",
		mustChange: false,
	});
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const dialog = await openSettings(page);

	const frames = [];
	for (const name of ["Profile", "Preferences", "Password"]) {
		await dialog.getByRole("button", { name, exact: true }).click();
		frames.push(await settingsFrame(dialog, name));
	}
	expect(frames.some((frame) => frame.overflows)).toBe(true);
	expect(frames.some((frame) => !frame.overflows)).toBe(true);
	const [first] = frames;
	for (const frame of frames) {
		expect(frame.clientWidth).toBe(first?.clientWidth);
		expect(frame.left).toBe(first?.left);
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`Profile shows a skeleton while it loads, and the pane keeps its width after, in ${colorScheme}`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1280, height: 800 });
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await routeApi(page, "**/me/profile", async (route) => {
			await held;
			await route.fallback();
		});
		await loginAs(page, "alice");
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
		const dialog = await openSettings(page);
		await dialog.getByRole("button", { name: "Profile", exact: true }).click();

		const loading = dialog.getByTestId("profile-loading");
		await expect(loading).toBeVisible();
		await expect(loading.locator(".pk-skel").first()).toBeVisible();
		await expect(loading).toHaveAttribute("aria-busy", "true");
		const heading = dialog.getByRole("heading", {
			level: 2,
			name: "Profile",
			exact: true,
		});
		const pane = heading.locator("xpath=../..");
		const before = await pane.evaluate((el) => el.clientWidth);
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		release();
		await expect(dialog.getByTestId("profile-signin")).toBeVisible();
		await expect(loading).toHaveCount(0);
		expect(await pane.evaluate((el) => el.clientWidth)).toBe(before);
	});
}
