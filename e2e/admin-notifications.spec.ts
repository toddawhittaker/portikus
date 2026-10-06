import { rm } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
	API_ORIGIN,
	createSignedInUser,
	createStudent,
	loginAs,
	routeApi,
	WEB_ORIGIN,
} from "./helpers";
import {
	type NotifyFile,
	playAlertsJob,
	putNotifyFile,
	putStaleRequest,
	readNotifyFile,
	resetNotifyStore,
} from "./notify-jobs";

/**
 * The Notifications section of the Settings tab (ADR 0052, ADR 0051). The
 * API writes request files into a fake job directory and the tests play the
 * root alerts job with playAlertsJob, which writes the settings file the API
 * reads back. Every test starts from no settings file. Delivery itself is
 * covered by the sender's unit tests: alert URLs must be https on port 443,
 * which no local receiver can listen on.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
	await resetNotifyStore();
});

// Obviously fake: secrets in tests must never look real.
const SECRETS = {
	smtpPassword: "fake-smtp-password-e2e",
	userKey: "fakeuserkeye2e000000000000000",
	appToken: "fakeapptokene2e00000000000000",
	webhookPath: "fake-webhook-path-e2e",
	ntfyTopic: "fake-ntfy-topic-e2e",
	ntfyToken: "fake-ntfy-token-e2e",
	teamsPath: "fake-teams-path-e2e",
};

/** Every channel on, with every secret stored; the hosts never resolve (RFC 2606). */
const ALL_ON: NotifyFile = {
	version: 1,
	smtp: {
		host: "smtp.example.invalid",
		port: 587,
		username: "portikus",
		password: SECRETS.smtpPassword,
		from: "Portikus <portikus@example.edu>",
	},
	alerts: {
		email: { to: ["ops@example.edu"] },
		pushover: { userKey: SECRETS.userKey, appToken: SECRETS.appToken },
		webhook: { url: `https://hooks.example.invalid/${SECRETS.webhookPath}` },
		ntfy: {
			url: `https://ntfy.example.invalid/${SECRETS.ntfyTopic}`,
			token: SECRETS.ntfyToken,
		},
		teams: { url: `https://teams.example.invalid/${SECRETS.teamsPath}` },
	},
	rootShellOpenedAlert: false,
};

async function open(
	page: Page,
	signIn: () => Promise<unknown> = () => loginAs(page, "carol"),
) {
	await signIn();
	await page.goto("/admin/settings");
	const section = page.getByTestId("notify-section");
	await expect(section.getByRole("heading", { name: "Notifications" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(section.getByTestId("notify-loading")).toHaveCount(0);
	return section;
}

const rootShellBox = (page: Page) =>
	page.getByRole("checkbox", { name: /^Alert when a root shell opens/ });

/** Click the label, as a person does; the box itself is a 1px native input under it. */
async function toggleRootShellAlert(page: Page, on: boolean) {
	await page.getByText("Alert when a root shell opens", { exact: true }).click();
	await expect(rootShellBox(page)).toBeChecked({ checked: on });
}

test("a new site has every channel and the root-shell alert off, and nothing to test", async ({
	page,
}) => {
	const section = await open(page);
	for (const name of [
		"Send alerts by email",
		"Send alerts to Pushover",
		"Send alerts to ntfy",
		"Send alerts to Microsoft Teams",
		"Send alerts to a webhook",
	]) {
		await expect(section.getByRole("checkbox", { name })).not.toBeChecked();
	}
	await expect(rootShellBox(page)).not.toBeChecked();
	await expect(section.getByRole("button", { name: /^Send test/ })).toHaveCount(0);
	await expect(section.getByTestId("notify-job")).toHaveText("");
});

test("channels and the root-shell alert save through the root job, and reload as saved", async ({
	page,
}) => {
	const section = await open(page);

	await section.getByRole("checkbox", { name: "Send alerts by email" }).check();
	await section.getByLabel("Mail server").fill("smtp.example.invalid");
	await section.getByLabel("User name").fill("portikus");
	await section.getByLabel("Password").fill(SECRETS.smtpPassword);
	await section.getByLabel("From").fill("Portikus <portikus@example.edu>");
	await section.getByLabel("Send to").fill("ops@example.edu\ndean@example.edu");
	await section.getByRole("checkbox", { name: "Send alerts to a webhook" }).check();
	await section
		.getByLabel("Webhook URL", { exact: true })
		.fill(`https://hooks.example.invalid/${SECRETS.webhookPath}`);
	await toggleRootShellAlert(page, true);
	await section.getByRole("button", { name: "Save notification settings" }).click();

	// The page waits for the job and keeps no typed secret meanwhile.
	await expect(section.getByTestId("notify-job")).toContainText("Saving.");
	await expect(section.getByLabel("Password")).toHaveValue("");
	await expect(section.getByLabel("Webhook URL", { exact: true })).toHaveValue("");

	const job = await playAlertsJob();
	// The request may hold secrets, so only its owner may read it.
	expect(job.mode).toBe(0o600);
	expect(job.settings.smtp?.password).toBe(SECRETS.smtpPassword);
	expect(job.settings.rootShellOpenedAlert).toBe(true);
	await expect(section.getByTestId("notify-job")).toContainText(
		"The new settings are in use.",
		{ timeout: 10_000 },
	);

	const file = await readNotifyFile();
	expect(file.alerts.email).toEqual({ to: ["ops@example.edu", "dean@example.edu"] });
	expect(file.alerts.webhook?.url).toContain(SECRETS.webhookPath);
	expect(file.rootShellOpenedAlert).toBe(true);

	await page.reload();
	await expect(rootShellBox(page)).toBeChecked({ timeout: 15_000 });
	await expect(
		section.getByRole("checkbox", { name: "Send alerts by email" }),
	).toBeChecked();
	await expect(section.getByLabel("Mail server")).toHaveValue("smtp.example.invalid");
	await expect(section.getByLabel("Send to")).toHaveValue(
		"ops@example.edu\ndean@example.edu",
	);
	await expect(
		section.getByText("Set, sending to hooks.example.invalid."),
	).toBeVisible();

	// Turning the alert off saves and reloads too.
	await toggleRootShellAlert(page, false);
	await section.getByRole("button", { name: "Save notification settings" }).click();
	const off = await playAlertsJob();
	expect(off.settings.rootShellOpenedAlert).toBe(false);
	// Nothing typed this time, so every stored secret is kept.
	expect(off.settings.smtp).not.toHaveProperty("password");
	expect(off.settings.alerts.webhook).toEqual({});
	await page.reload();
	await expect(rootShellBox(page)).not.toBeChecked({ timeout: 15_000 });
	expect((await readNotifyFile()).smtp?.password).toBe(SECRETS.smtpPassword);
});

test("stored secrets never reach the page, only that they are set and their host", async ({
	page,
}) => {
	await putNotifyFile(ALL_ON);
	const read = page.waitForResponse(
		(r) => r.url().endsWith("/admin/notifications") && r.request().method() === "GET",
	);
	const section = await open(page);
	const body = await (await read).text();
	const html = await page.content();
	for (const secret of Object.values(SECRETS)) {
		expect(body).not.toContain(secret);
		expect(html).not.toContain(secret);
	}
	for (const label of [
		"Password",
		"User key",
		"API token",
		"Topic URL",
		"Access token",
		"Workflows webhook URL",
		"Webhook URL",
	]) {
		await expect(section.getByLabel(label, { exact: true })).toHaveValue("");
	}
	await expect(section.getByLabel("Password")).toHaveAttribute("type", "password");
	await expect(
		section.getByText("Set, sending to ntfy.example.invalid."),
	).toBeVisible();
	await expect(
		section.getByText("Set, sending to teams.example.invalid."),
	).toBeVisible();
});

test("a refused change says why in plain words and leaves the settings alone", async ({
	page,
}) => {
	const section = await open(page);
	await section
		.getByRole("checkbox", { name: "Send alerts to Microsoft Teams" })
		.check();
	await section
		.getByLabel("Workflows webhook URL")
		.fill(`https://teams.example.invalid/${SECRETS.teamsPath}`);
	await section.getByRole("button", { name: "Save notification settings" }).click();
	await playAlertsJob({ refuse: "invalid_teams" });

	await expect(section.getByTestId("notify-job")).toContainText(
		"Not saved. The server refused the Teams URL. Nothing changed.",
		{ timeout: 10_000 },
	);
	expect((await readNotifyFile()).alerts.teams).toBeNull();
	// Save is offered again once the job has ended.
	await expect(
		section.getByRole("button", { name: "Save notification settings" }),
	).not.toHaveAttribute("aria-disabled", "true");
});

test("a failed change says what to do on the server", async ({ page }) => {
	const section = await open(page);
	await toggleRootShellAlert(page, true);
	await section.getByRole("button", { name: "Save notification settings" }).click();
	await playAlertsJob({ fail: "write_failed" });
	await expect(section.getByTestId("notify-job")).toContainText(
		"Look for portikus-alerts-job in the server's journal.",
		{ timeout: 10_000 },
	);
});

test("while a change waits, Save says why it is unavailable, and a second save is refused as busy", async ({
	page,
	context,
}) => {
	const section = await open(page);
	// A second tab whose reads still show no job, as one loaded just before
	// the first save would; its save reaches the real API.
	const other = await context.newPage();
	await routeApi(other, "**/admin/notifications", async (route, request) => {
		if (request.method() !== "GET") return route.fallback();
		const real = await route.fetch();
		return route.fulfill({
			response: real,
			json: { ...(await real.json()), job: null },
		});
	});
	await other.goto("/admin/settings");
	const otherSection = other.getByTestId("notify-section");
	await expect(otherSection.getByTestId("notify-loading")).toHaveCount(0, {
		timeout: 15_000,
	});

	await toggleRootShellAlert(page, true);
	const save = section.getByRole("button", { name: "Save notification settings" });
	await save.click();
	await expect(save).toHaveAttribute("aria-disabled", "true");
	await expect(section.getByText("A change is being applied.")).toBeVisible();

	await otherSection
		.getByRole("button", { name: "Save notification settings" })
		.click();
	await expect(otherSection.getByTestId("notify-error")).toHaveText(
		"A notification settings change is already waiting or running.",
	);

	await playAlertsJob();
	await expect(save).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
	await expect(section.getByTestId("notify-job")).toContainText(
		"The new settings are in use.",
	);
});

test("a new mail server or ntfy host warns that its stored secret is cleared", async ({
	page,
}) => {
	await putNotifyFile(ALL_ON);
	const section = await open(page);

	await section.getByLabel("Mail server").fill("mail.example.invalid");
	// The warning is worked out once the field is left, and read out then.
	await expect(section.getByText(/will be cleared/)).toHaveCount(0);
	await section.getByLabel("Mail server").blur();
	await expect(page.getByTestId("notify-warning-announce")).toHaveText(
		/the stored password will be cleared/,
	);
	await expect(
		section
			.getByTestId("notify-email")
			.getByText(/the stored password will be cleared/),
	).toBeVisible();
	await section.getByRole("button", { name: "Save notification settings" }).click();
	await expect(section.getByLabel("Password")).toBeFocused();
	await expect(
		section.getByText("Enter the password for this user name."),
	).toBeVisible();

	await section.getByLabel("Topic URL").fill("https://ntfy.other.invalid/alerts");
	await section.getByLabel("Topic URL").blur();
	await expect(
		section
			.getByTestId("notify-ntfy")
			.getByText(/not on ntfy\.example\.invalid, so the stored token will be cleared/),
	).toBeVisible();

	await section.getByLabel("Password").fill("fake-new-password-e2e");
	await section.getByRole("button", { name: "Save notification settings" }).click();
	const job = await playAlertsJob();
	expect(job.settings.smtp).toMatchObject({
		host: "mail.example.invalid",
		password: "fake-new-password-e2e",
	});
	// No token was typed, so the job clears the old one for the new host.
	expect(job.settings.alerts.ntfy).toEqual({
		url: "https://ntfy.other.invalid/alerts",
	});
	await expect(section.getByTestId("notify-job")).toContainText(
		"The new settings are in use.",
		{ timeout: 10_000 },
	);
	expect((await readNotifyFile()).alerts.ntfy?.token).toBe("");
	await expect(section.getByLabel("Access token")).toHaveAccessibleDescription(
		"Not set. Only for a topic that needs one.",
	);
});

test("Send test goes to the one saved channel named, through the saved settings", async ({
	page,
	context,
}) => {
	await putNotifyFile(ALL_ON);
	// An administrator of its own, so the per-administrator test limit is fresh.
	const section = await open(page, () => createSignedInUser(context, "administrator"));

	const webhook = section.getByTestId("notify-webhook");
	const answer = page.waitForResponse((r) => r.url().endsWith("/admin/alerts/test"));
	await webhook.getByRole("button", { name: "Send test to the webhook" }).click();
	const response = await answer;
	expect(response.request().postDataJSON()).toEqual({ channel: "webhook" });
	// Only the webhook was tried, though five channels are saved; its host
	// never resolves, so the API says it could not reach it.
	expect(await response.json()).toEqual({
		results: [{ channel: "webhook", ok: false, error: "unreachable" }],
	});
	await expect(webhook.getByTestId("notify-webhook-test-result")).toHaveText(
		"Not sent: this server could not reach it.",
	);
	// The other channels' results stay empty.
	await expect(section.getByTestId("notify-ntfy-test-result")).toHaveText("");

	// An edit not saved yet: the button says the test still uses the saved settings.
	await expect(webhook.getByText("Tests use the saved settings.")).toHaveCount(0);
	await webhook
		.getByLabel("Webhook URL", { exact: true })
		.fill("https://hooks.other.invalid/new");
	await expect(
		webhook.getByRole("button", { name: "Send test to the webhook" }),
	).toHaveAccessibleDescription(/^Tests use the saved settings\./);

	// A channel turned on but not saved yet has nothing to test.
	await putNotifyFile({ ...ALL_ON, alerts: { ...ALL_ON.alerts, teams: null } });
	await page.reload();
	await section
		.getByRole("checkbox", { name: "Send alerts to Microsoft Teams" })
		.check();
	await expect(
		section.getByTestId("notify-teams").getByText("Save first, then send a test."),
	).toBeVisible();
	await expect(
		section.getByTestId("notify-teams").getByRole("button", { name: /^Send test/ }),
	).toHaveCount(0);
});

test("students see no Settings tab and the API refuses them", async ({
	page,
	context,
}) => {
	await createStudent(context);
	await page.goto("/admin/settings");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });

	const headers = { origin: WEB_ORIGIN };
	expect((await page.request.get(`${API_ORIGIN}/admin/notifications`)).status()).toBe(
		403,
	);
	const put = await page.request.put(`${API_ORIGIN}/admin/notifications`, {
		headers,
		data: {
			smtp: null,
			alerts: { email: null, pushover: null, webhook: null, ntfy: null, teams: null },
			rootShellOpenedAlert: true,
		},
	});
	expect(put.status()).toBe(403);
	const tested = await page.request.post(`${API_ORIGIN}/admin/alerts/test`, {
		headers,
		data: {},
	});
	expect(tested.status()).toBe(403);
	expect(await readNotifyFile()).toMatchObject({ rootShellOpenedAlert: false });
});

test("more than five tests a minute are refused, and the page says to wait", async ({
	page,
	context,
}) => {
	await putNotifyFile(ALL_ON);
	const section = await open(page, () => createSignedInUser(context, "administrator"));
	const button = section.getByRole("button", { name: "Send test to the webhook" });
	const result = section.getByTestId("notify-webhook-test-result");
	for (let sent = 0; sent < 5; sent++) {
		const answer = page.waitForResponse((r) => r.url().endsWith("/admin/alerts/test"));
		await button.click();
		expect((await answer).status()).toBe(200);
		await expect(button).not.toHaveAttribute("aria-busy", "true");
	}
	const refused = page.waitForResponse((r) => r.url().endsWith("/admin/alerts/test"));
	await button.click();
	const answer = await refused;
	expect(answer.status()).toBe(429);
	expect(Number(answer.headers()["retry-after"])).toBeGreaterThan(0);
	await expect(result).toHaveText(
		"Not sent: too many test alerts just now. Try again in a minute.",
	);
});

test("a change the job never took is shown as not finished, and a new save goes through", async ({
	page,
}) => {
	const stale = await putStaleRequest(6);
	const section = await open(page);
	await expect(section.getByTestId("notify-job")).toContainText(
		"The last change did not finish",
	);
	const save = section.getByRole("button", { name: "Save notification settings" });
	await expect(save).not.toHaveAttribute("aria-disabled", "true");

	await toggleRootShellAlert(page, true);
	const answer = page.waitForResponse(
		(r) => r.url().endsWith("/admin/notifications") && r.request().method() === "PUT",
	);
	await save.click();
	expect((await answer).status()).toBe(202);
	await expect(section.getByTestId("notify-job")).toContainText("Saving.");

	await rm(stale);
	await playAlertsJob();
	await expect(section.getByTestId("notify-job")).toContainText(
		"The new settings are in use.",
		{ timeout: 10_000 },
	);
	expect((await readNotifyFile()).rootShellOpenedAlert).toBe(true);
});
