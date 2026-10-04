import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";
import { FAKE_ALERT_WEBHOOK_PORT } from "./ports";

/**
 * The Send test alert button on the Settings tab (STACK.md section 15). The
 * e2e API's webhook points at a receiver this file starts; the "nothing set
 * up" case fakes the API's empty answer, since the one API has a webhook.
 */
test.describe.configure({ mode: "serial" });

let receiver: Server;
const received: Record<string, unknown>[] = [];

test.beforeAll(async () => {
	receiver = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			received.push(JSON.parse(body));
			res.end();
		});
	});
	await new Promise<void>((r) =>
		receiver.listen(FAKE_ALERT_WEBHOOK_PORT, "127.0.0.1", r),
	);
});

test.afterAll(async () => {
	await new Promise((r) => receiver.close(r));
});

test("with no channel set up, the button says nothing was sent", async ({ page }) => {
	await page.route("**/admin/alerts/test", (route) =>
		route.fulfill({ json: { results: [] } }),
	);
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const section = page.getByTestId("alerts-section");
	await expect(section.getByRole("heading", { name: "Alerts" })).toBeVisible();
	await section.getByRole("button", { name: "Send test alert" }).click();
	await expect(page.getByTestId("test-alert-result")).toContainText(
		"No alert channel is set up, so nothing was sent.",
	);
});

test("a configured webhook receives the test alert", async ({ page }) => {
	received.length = 0;
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await page.getByRole("button", { name: "Send test alert" }).click();
	await expect(page.getByTestId("test-alert-result")).toHaveText("Webhook: sent.");
	expect(received).toHaveLength(1);
	expect(received[0]).toMatchObject({
		title: "Test alert from Portikus",
		tone: "warning",
	});
	expect(Object.keys(received[0] ?? {}).sort()).toEqual([
		"at",
		"site",
		"text",
		"title",
		"tone",
	]);
});
