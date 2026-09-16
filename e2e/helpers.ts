import type { APIRequestContext, Page } from "@playwright/test";

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
