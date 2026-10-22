import { expect, type Page, type Request, test } from "@playwright/test";
import {
	lockSharedState,
	loginAs,
	query,
	routeApi,
	SETTINGS_ROW_LOCK,
} from "./helpers";

/**
 * Saving the Settings tab (SPEC.md section 20.1): each section saves with
 * its own button and sends only the fields it changed, nothing saves on a
 * click, Discard changes puts the saved values back, a failed load offers
 * "Load again", and a failed save keeps every edit. These tests write the
 * one settings row, so they run one after another under its lock.
 */
test.describe.configure({ mode: "serial" });

let release: (() => Promise<void>) | undefined;
let before: Record<string, unknown> | undefined;

const COLUMNS =
	"idle_stop_minutes, shutdown_grace_seconds, keep_running_max_hours, guard_window_minutes, account_email_enabled, voice_input_enabled, code_help_languages, acceptable_use_text, acceptable_use_version";

async function row(): Promise<Record<string, unknown>> {
	const [found] = await query(`select ${COLUMNS} from settings where id = 1`);
	if (!found) throw new Error("no settings row");
	return found;
}

test.beforeAll(async () => {
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
	before = await row();
});

test.afterAll(async () => {
	if (before) {
		await query(
			"update settings set idle_stop_minutes = $1, shutdown_grace_seconds = $2, keep_running_max_hours = $3, guard_window_minutes = $4, account_email_enabled = $5 where id = 1",
			[
				before.idle_stop_minutes,
				before.shutdown_grace_seconds,
				before.keep_running_max_hours,
				before.guard_window_minutes,
				before.account_email_enabled,
			],
		);
	}
	await release?.();
});

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("notify-loading")).toHaveCount(0);
}

/** Every write the page sends to the settings endpoints, as method, path and body. */
function recordWrites(page: Page) {
	const writes: { path: string; body: unknown }[] = [];
	page.on("request", (request: Request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" || request.resourceType() === "document") return;
		if (!path.startsWith("/admin/settings") && !path.startsWith("/admin/notifications"))
			return;
		writes.push({ path, body: request.postDataJSON() });
	});
	return writes;
}

test("When workspaces stop saves only the field that changed", async ({ page }) => {
	await query("update settings set idle_stop_minutes = 60 where id = 1");
	await open(page);
	const writes = recordWrites(page);
	const lastChanged = page.getByTestId("settings-last-changed").locator("time");
	const stampBefore = await lastChanged.getAttribute("datetime");

	await page.getByTestId("settings-idleStopMinutes").fill("45");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("1 unsaved change");
	await expect(page.getByTestId("settings-stop")).toContainText(
		"Not saved. Was 60 minutes.",
	);
	await page.getByRole("button", { name: "Save stop times" }).click();
	await expect(page.getByTestId("settings-stop-state")).toHaveText("Saved.");

	expect(writes).toEqual([{ path: "/admin/settings", body: { idleStopMinutes: 45 } }]);
	expect((await row()).idle_stop_minutes).toBe(45);
	// The site-wide line moves with the save; no per-section time is shown.
	await expect(lastChanged).not.toHaveAttribute("datetime", stampBefore ?? "");
	await expect(page.getByTestId("settings-stop")).not.toContainText("Not saved");
});

test("Resource guard saves only the field that changed", async ({ page }) => {
	await open(page);
	const writes = recordWrites(page);
	const field = page.getByRole("textbox", { name: "Measuring period" });
	const was = Number(await field.inputValue());
	const next = was === 40 ? 45 : 40;
	await field.fill(String(next));
	await page.getByRole("button", { name: "Save resource guard" }).click();
	await expect(page.getByTestId("settings-guard-state")).toHaveText("Saved.");
	expect(writes).toEqual([
		{ path: "/admin/settings", body: { guardWindowMinutes: next } },
	]);
	expect((await row()).guard_window_minutes).toBe(next);
});

test("Acceptable use sends only the statement, and Restore saves null at once after its confirm", async ({
	page,
}) => {
	// A real save would ask every user of the parallel run to accept again,
	// so the API's answer is made here and only the request is checked.
	const bodies: unknown[] = [];
	await open(page);
	await routeApi(page, "**/admin/settings", async (route, request) => {
		if (request.method() !== "PUT") return route.fallback();
		const body = request.postDataJSON() as { acceptableUseText: string | null };
		bodies.push(body);
		const current = await (await page.request.get("/admin/settings")).json();
		return route.fulfill({
			json: {
				...current,
				acceptableUseText: body.acceptableUseText,
				acceptableUseVersion: current.acceptableUseVersion + 1,
			},
		});
	});
	const text = page.getByTestId("aup-text");
	await text.fill("Be kind. Do your own work.");
	await page.getByRole("button", { name: "Save and ask everyone to accept" }).click();
	await expect(page.getByTestId("settings-aup-state")).toHaveText("Saved.");
	expect(bodies).toEqual([{ acceptableUseText: "Be kind. Do your own work." }]);

	// Cancelling the restore sends nothing.
	await page.getByTestId("aup-restore").click();
	const dialog = page.getByTestId("aup-restore-dialog");
	await dialog.getByRole("button", { name: "Keep this statement" }).click();
	await expect(dialog).toHaveCount(0);
	expect(bodies).toHaveLength(1);

	await page.getByTestId("aup-restore").click();
	await dialog.getByRole("button", { name: "Restore built-in text" }).click();
	await expect.poll(() => bodies.length).toBe(2);
	expect(bodies[1]).toEqual({ acceptableUseText: null });
	await expect(page.locator("#aup-text-hint")).toContainText("the built-in text");
	const [stored] = await query<{ text: string | null }>(
		"select acceptable_use_text as text from settings where id = 1",
	);
	expect(stored?.text).toBe(before?.acceptable_use_text ?? null);
});

test("Email and alerts saves account email alone when only it changed", async ({
	page,
}) => {
	await query("update settings set account_email_enabled = false where id = 1");
	await open(page);
	const writes = recordWrites(page);
	const section = page.getByTestId("settings-mail");
	await section.getByText("Email password reset and invitation links").click();
	await section.getByRole("button", { name: "Save email and alerts" }).click();
	await expect(page.getByTestId("settings-mail-state")).toHaveText("Saved.");
	expect(writes).toEqual([
		{ path: "/admin/settings", body: { accountEmailEnabled: true } },
	]);
	expect((await row()).account_email_enabled).toBe(true);
});

test("nothing saves on a click or a keystroke in any section", async ({ page }) => {
	await open(page);
	const stored = await row();
	const writes = recordWrites(page);

	await page.getByTestId("settings-idleStopMinutes").fill("33");
	await page.getByRole("textbox", { name: "Measuring period" }).fill("50");
	const tools = page.getByRole("region", { name: "Student tools" });
	await tools.getByRole("checkbox", { name: "Python" }).click();
	await tools.getByRole("checkbox", { name: "Allow voice input" }).click();
	await page.getByTestId("aup-text").fill("A draft statement.");
	await page
		.getByTestId("settings-mail")
		.getByText("Email password reset and invitation links")
		.click();

	for (const id of ["stop", "guard", "tools", "aup", "mail"]) {
		await expect(page.getByTestId(`settings-${id}-state`)).toHaveText(
			/^\d+ unsaved changes?$/,
		);
	}
	await page.waitForTimeout(1500);
	expect(writes).toEqual([]);
	expect(await row()).toEqual(stored);
});

test("Discard changes puts back the saved values and saves nothing", async ({
	page,
}) => {
	await open(page);
	const writes = recordWrites(page);
	const idle = page.getByTestId("settings-idleStopMinutes");
	const grace = page.getByTestId("settings-shutdownGraceSeconds");
	const [idleWas, graceWas] = [await idle.inputValue(), await grace.inputValue()];
	await idle.fill("21");
	await grace.fill("3");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("2 unsaved changes");

	// Another section's edit is not this section's to discard.
	const window = page.getByRole("textbox", { name: "Measuring period" });
	await window.fill("55");

	await page.getByTestId("settings-stop-discard").click();
	await expect(idle).toHaveValue(idleWas);
	await expect(grace).toHaveValue(graceWas);
	await expect(page.getByTestId("settings-stop-state")).toHaveText(
		"No unsaved changes.",
	);
	await expect(page.getByTestId("settings-stop-discard")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Save stop times" })).toBeFocused();
	await expect(window).toHaveValue("55");
	await expect(page.getByTestId("settings-guard-state")).toHaveText("1 unsaved change");
	expect(writes).toEqual([]);
});

test("a failed load says nothing changed and Load again reads the settings", async ({
	page,
}) => {
	let fail = true;
	await routeApi(page, "**/admin/settings", async (route, request) => {
		if (request.method() !== "GET" || !fail) return route.fallback();
		return route.fulfill({ status: 500, json: { error: "boom" } });
	});
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const stop = page.getByTestId("settings-stop");
	await expect(stop).toContainText("These settings could not be loaded.", {
		timeout: 30_000,
	});
	await expect(stop).toContainText("Nothing has been changed.");
	// The four sections share one read, so the failure is announced once.
	await expect(page.getByRole("alert")).toHaveCount(1);
	await expect(page.getByTestId("settings-idleStopMinutes")).toHaveCount(0);

	fail = false;
	await stop.getByRole("button", { name: "Load again" }).click();
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await expect(page.getByText("These settings could not be loaded.")).toHaveCount(0);
});

test("a failed save keeps the section's edits and every other section's", async ({
	page,
}) => {
	await open(page);
	const stored = await row();
	let fail = true;
	await routeApi(page, "**/admin/settings", async (route, request) => {
		if (request.method() !== "PUT" || !fail) return route.fallback();
		return route.fulfill({ status: 500, json: { error: "the database is away" } });
	});
	const idle = page.getByTestId("settings-idleStopMinutes");
	const window = page.getByRole("textbox", { name: "Measuring period" });
	await idle.fill("44");
	await window.fill("35");

	await page.getByRole("button", { name: "Save stop times" }).click();
	await expect(page.getByTestId("settings-stop-state")).toHaveText(/^Not saved\. /);
	await expect(idle).toHaveValue("44");
	await expect(window).toHaveValue("35");
	await expect(page.getByTestId("settings-guard-state")).toHaveText("1 unsaved change");
	expect((await row()).idle_stop_minutes).toBe(stored.idle_stop_minutes);

	fail = false;
	await page.getByRole("button", { name: "Save stop times" }).click();
	await expect(page.getByTestId("settings-stop-state")).toHaveText("Saved.");
	expect((await row()).idle_stop_minutes).toBe(44);
	// The guard edit is still waiting for its own Save.
	await expect(window).toHaveValue("35");
	expect((await row()).guard_window_minutes).toBe(stored.guard_window_minutes);
});
