import { expect, test } from "@playwright/test";
import { apiLoginAs, loginAs } from "./helpers";

const WEB_ORIGIN = "http://127.0.0.1:5173";

test("a student can log in through the mock identity provider", async ({ page }) => {
	await loginAs(page, "alice");

	await expect(page.locator("[data-testid=me]")).toContainText("Alice");

	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(200);
	expect((await me.json()).displayName).toBe("Alice Student");
});

test("signing out ends the session", async ({ page }) => {
	await loginAs(page, "alice");

	await page.click("[data-testid=me]");
	await page.click("[data-testid=signout]");

	await expect(page.locator("[data-testid=signin]")).toBeVisible();
	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(401);
});

// The ids this file uses (me, signin, signout, workspace-state) stay the
// same in the Epic 6 shell (plan, E1), so only the chrome around them moves.
test("the workspace panel shows a state after login", async ({ page }) => {
	await loginAs(page, "alice");

	// The worker is not running here, so only assert that the socket
	// delivered a workspace message, not which state it reported.
	const state = page.locator("[data-testid=workspace-state]");
	await expect(state).toBeVisible({ timeout: 10_000 });
	await expect(state).not.toBeEmpty();
});

test("an anonymous visitor cannot read or create anything", async ({ request }) => {
	expect((await request.get("/auth/me")).status()).toBe(401);

	const created = await request.post("/workspaces", {
		headers: { origin: WEB_ORIGIN },
		data: {},
	});
	expect(created.status()).toBe(401);
});

test("one student cannot reach another student's workspace", async ({ browser }) => {
	const aliceContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	const bobContext = await browser.newContext({ baseURL: WEB_ORIGIN });

	try {
		await apiLoginAs(aliceContext.request, "alice");
		await apiLoginAs(bobContext.request, "bob");

		const created = await aliceContext.request.post("/workspaces", {
			headers: { origin: WEB_ORIGIN },
			data: {},
		});
		expect([200, 201]).toContain(created.status());
		const workspaceId = (await created.json()).id;
		expect(workspaceId).toBeTruthy();

		const bobRead = await bobContext.request.get(`/workspaces/${workspaceId}`);
		expect(bobRead.status()).toBe(404);

		const aliceRead = await aliceContext.request.get(`/workspaces/${workspaceId}`);
		expect(aliceRead.status()).toBe(200);

		const bobAdmin = await bobContext.request.get("/admin/workspaces");
		expect(bobAdmin.status()).toBe(403);
	} finally {
		await aliceContext.close();
		await bobContext.close();
	}
});
