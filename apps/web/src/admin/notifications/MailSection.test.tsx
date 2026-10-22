import {
	type AdminNotifications,
	NOTIFY_FILE_OFF,
	type NotificationSettingsView,
	type NotifyJobView,
	notificationSettingsView,
} from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { MailSection } from "./MailSection.js";

afterEach(() => vi.unstubAllGlobals());

const JOB_ID = "33333333-3333-4333-8333-333333333333";

const SETTINGS: NotificationSettingsView = {
	smtp: {
		host: "smtp.example.edu",
		port: 587,
		username: "portikus",
		passwordSet: true,
		from: "Portikus <portikus@example.edu>",
	},
	alerts: {
		email: { to: ["ops@example.edu"] },
		pushover: null,
		webhook: { host: "hooks.slack.com", urlSet: true },
		ntfy: { host: "ntfy.sh", urlSet: true, tokenSet: true },
		teams: null,
	},
	rootShellOpenedAlert: false,
};

function job(over: Partial<NotifyJobView> = {}): NotifyJobView {
	return {
		id: JOB_ID,
		state: "queued",
		code: null,
		channels: [],
		hosts: [],
		// Fresh, so a queued job is not already stale when the test runs.
		requestedAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		...over,
	};
}

/** The platform settings, for the account email switch. */
const PLATFORM = {
	shutdownGraceSeconds: 600,
	logLevel: null,
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 5,
	cpuIdleLiftPercent: 10,
	cpuThrottleHoldAfter: 3,
	cpuThrottleHoldHours: 24,
	keepRunningMaxHours: 12,
	voiceInputEnabled: true,
	codeHelpLanguages: ["python", "typescript"],
	accountEmailEnabled: false,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
	updatedAt: null,
};

/**
 * Answers the notifications GET with `page`, its PUT with `put`, the test
 * with `tested`, and a save of the platform settings with `account`.
 */
function serve(
	page: Omit<AdminNotifications, "storedFileUnreadable"> & {
		storedFileUnreadable?: boolean;
	},
	answers: {
		put?: () => Response;
		tested?: () => Response;
		account?: () => Response;
	} = {},
) {
	return stubFetch((url, init) => {
		if (url === "/admin/root-shell") return json(200, { enabled: true });
		if (url === "/admin/settings") {
			if (init?.method === "PUT") {
				return answers.account
					? answers.account()
					: json(200, { ...PLATFORM, ...JSON.parse(String(init.body)) });
			}
			return json(200, PLATFORM);
		}
		if (url === "/admin/alerts/test") {
			return answers.tested
				? answers.tested()
				: json(200, { results: [{ channel: "webhook", ok: true }] });
		}
		if (init?.method === "PUT") {
			return answers.put ? answers.put() : json(202, job());
		}
		return json(200, { storedFileUnreadable: false, ...page });
	});
}

/** Tick the root-shell alert, so the section has a change to save. */
async function changeSomething() {
	fireEvent.click(
		await screen.findByRole("checkbox", { name: /^Alert when a root shell opens/ }),
	);
}

function box(name: string | RegExp): HTMLInputElement {
	return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

/** The text of the elements an element's aria-describedby names. */
function description(element: HTMLElement): string {
	return (element.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ");
}

function sent(fetch: ReturnType<typeof stubFetch>, url: string, method: string) {
	return fetch.mock.calls
		.filter(([u, init]) => u === url && init?.method === method)
		.map(([, init]) => JSON.parse(String(init?.body)));
}

test("without the alerts job, only account email is offered", async () => {
	stubFetch((url) =>
		url === "/admin/settings"
			? json(200, PLATFORM)
			: json(404, { code: "NOT_FOUND", message: "Not found." }),
	);
	renderWithQuery(<MailSection />);
	expect((await screen.findByTestId("notify-off")).textContent).toContain(
		"This site runs without the alerts job",
	);
	expect(
		screen.getByRole("checkbox", { name: "Email password reset and invitation links" }),
	).toBeDefined();
	expect(screen.queryByLabelText("Host name")).toBeNull();
});

test("a failed read offers to load again", async () => {
	stubFetch((url) =>
		url === "/admin/settings"
			? json(200, PLATFORM)
			: json(500, { code: "INTERNAL", message: "The server did not answer." }),
	);
	renderWithQuery(<MailSection />);
	expect((await screen.findByRole("alert")).textContent).toContain(
		"These settings could not be loaded.",
	);
	expect(screen.getByRole("button", { name: "Load again" })).toBeDefined();
});

test("shows each channel with a switch, and saved secrets only as set and their host", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	await screen.findByTestId("notify-email");
	// The mail server first, then account email, the channels and the root-shell alert.
	expect(
		screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent),
	).toEqual(["Mail server", "Account email", "Alert channels", "Root shell"]);
	expect(box("Send alerts by email").checked).toBe(true);
	expect(box("Send alerts to Pushover").checked).toBe(false);
	expect(box(/^Alert when a root shell opens/).checked).toBe(false);

	const password = screen.getByLabelText("Password");
	expect((password as HTMLInputElement).value).toBe("");
	expect(password.getAttribute("type")).toBe("password");
	expect(description(password)).toMatch(
		"Set. Leave blank to keep it. A new server, port or user name clears it.",
	);
	expect((screen.getByLabelText("Webhook URL") as HTMLInputElement).value).toBe("");
	expect(description(screen.getByLabelText("Webhook URL"))).toMatch(
		"Set, sending to hooks.slack.com. Leave blank to keep it.",
	);
	// A channel turned off shows no fields.
	expect(screen.queryByLabelText("User key")).toBeNull();
});

test("warns when the stored settings could not be read, and only then", async () => {
	serve({
		settings: notificationSettingsView(NOTIFY_FILE_OFF),
		job: null,
		storedFileUnreadable: true,
	});
	renderWithQuery(<MailSection />);
	expect((await screen.findByTestId("notify-unreadable")).textContent).toBe(
		"The stored notification settings could not be read, so every channel shows as off. Saving replaces them.",
	);
	expect(box("Send alerts by email").checked).toBe(false);
});

test("shows no unreadable warning for a readable file", async () => {
	serve({ settings: SETTINGS, job: null, storedFileUnreadable: false });
	renderWithQuery(<MailSection />);
	await screen.findByTestId("notify-email");
	expect(screen.queryByTestId("notify-unreadable")).toBeNull();
});

test("with root shells off, the root-shell alert stays and its description says they are off", async () => {
	for (const enabled of [false, true]) {
		stubFetch((url) =>
			url === "/admin/root-shell"
				? json(200, { enabled })
				: url === "/admin/settings"
					? json(200, PLATFORM)
					: json(200, { settings: SETTINGS, job: null, storedFileUnreadable: false }),
		);
		renderWithQuery(<MailSection />);
		const alert = await screen.findByRole("checkbox", {
			name: /^Alert when a root shell opens/,
		});
		if (enabled) {
			await waitFor(() =>
				expect(description(alert)).toContain("each time anyone opens a root shell"),
			);
			expect(description(alert)).not.toContain("Root shells are off");
		} else {
			await waitFor(() =>
				expect(description(alert)).toContain("Root shells are off on this server."),
			);
			expect((alert as HTMLInputElement).disabled).toBe(false);
		}
		cleanup();
	}
});

test("a save sends no secret that was not typed, and drops the typed ones after", async () => {
	const fetch = serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	fireEvent.click(
		await screen.findByRole("checkbox", { name: /^Alert when a root shell opens/ }),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Send alerts to Pushover" }));
	fireEvent.change(screen.getByLabelText("User key"), { target: { value: "u123" } });
	fireEvent.change(screen.getByLabelText("API token"), { target: { value: "a456" } });
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));

	await waitFor(() =>
		expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(1),
	);
	expect(sent(fetch, "/admin/notifications", "PUT")[0]).toEqual({
		smtp: {
			host: "smtp.example.edu",
			port: 587,
			username: "portikus",
			from: "Portikus <portikus@example.edu>",
		},
		alerts: {
			email: { to: ["ops@example.edu"] },
			pushover: { userKey: "u123", appToken: "a456" },
			ntfy: {},
			teams: null,
			webhook: {},
		},
		rootShellOpenedAlert: true,
	});
	await waitFor(() =>
		expect((screen.getByLabelText("User key") as HTMLInputElement).value).toBe(""),
	);
	expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
});

test("a field error stops the save and takes focus", async () => {
	const fetch = serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	fireEvent.click(
		await screen.findByRole("checkbox", { name: "Send alerts to Microsoft Teams" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));

	const url = screen.getByLabelText("Workflows webhook URL");
	await waitFor(() => expect(document.activeElement).toBe(url));
	expect(url.getAttribute("aria-invalid")).toBe("true");
	expect(description(url)).toMatch(/Enter the Workflows webhook URL\./);
	expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(0);
});

test("a new mail server warns, once it is left, that the stored password is cleared", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const host = await screen.findByLabelText("Host name");
	const password = screen.getByLabelText("Password");
	fireEvent.change(host, { target: { value: "mail.example.edu" } });
	// Nothing flashes while the person is still typing.
	expect(description(password)).not.toMatch(/will be cleared/);
	expect(screen.getByTestId("notify-warning-announce").textContent).toBe("");

	fireEvent.blur(host);
	expect(description(password)).toBe(
		"A password is stored. The server, port or user name changed, so the stored password will be cleared. Enter it again.",
	);
	expect(screen.getByTestId("notify-warning-announce").textContent).toBe(
		"The server, port or user name changed, so the stored password will be cleared. Enter it again.",
	);

	// A new password takes the warning away once that field is left.
	fireEvent.change(password, { target: { value: "new" } });
	fireEvent.blur(password);
	expect(description(password)).not.toMatch(/will be cleared/);
});

test("an ntfy URL on another server warns, once it is left, that the token is cleared", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const url = await screen.findByLabelText("Topic URL");
	fireEvent.change(url, { target: { value: "https://ntfy.example.edu/alerts" } });
	expect(description(screen.getByLabelText("Access token"))).not.toMatch(/cleared/);
	fireEvent.blur(url);
	expect(description(screen.getByLabelText("Access token"))).toBe(
		"A token is stored. The new URL is not on ntfy.sh, so the stored token will be cleared. Enter it again if the new server needs one.",
	);
	expect(screen.getByTestId("notify-warning-announce").textContent).toMatch(
		/not on ntfy\.sh, so the stored token will be cleared/,
	);
});

test("Enter in the topic URL stops once at the token warning, and a second Save goes ahead", async () => {
	const fetch = serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const url = await screen.findByLabelText("Topic URL");
	fireEvent.change(url, { target: { value: "https://ntfy.example.edu/alerts" } });
	// Enter submits without leaving the field.
	fireEvent.submit(url.closest("form") as HTMLFormElement);
	const token = screen.getByLabelText("Access token");
	expect(document.activeElement).toBe(token);
	expect(description(token)).toMatch(/so the stored token will be cleared/);
	expect(screen.getByTestId("notify-warning-announce").textContent).toMatch(
		/so the stored token will be cleared/,
	);
	expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(0);

	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(1),
	);
	expect(sent(fetch, "/admin/notifications", "PUT")[0].alerts.ntfy).toEqual({
		url: "https://ntfy.example.edu/alerts",
	});
});

test("a warning that goes away and comes back is read out again", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const url = await screen.findByLabelText("Topic URL");
	const announce = screen.getByTestId("notify-warning-announce");
	fireEvent.change(url, { target: { value: "https://ntfy.example.edu/alerts" } });
	fireEvent.blur(url);
	expect(announce.textContent).toMatch(/will be cleared/);
	fireEvent.change(url, { target: { value: "https://ntfy.sh/other" } });
	fireEvent.blur(url);
	expect(announce.textContent).toBe("");
	fireEvent.change(url, { target: { value: "https://ntfy.example.edu/alerts" } });
	fireEvent.blur(url);
	expect(announce.textContent).toMatch(/will be cleared/);
});

test("a test button says tests use the saved settings once its channel is edited", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const webhook = await screen.findByTestId("notify-webhook");
	const button = within(webhook).getByRole("button", {
		name: "Send test to the webhook",
	});
	expect(within(webhook).queryByText("Tests use the saved settings.")).toBeNull();
	fireEvent.change(within(webhook).getByLabelText("Webhook URL"), {
		target: { value: "https://hooks.example.com/new" },
	});
	expect(description(button)).toContain("Tests use the saved settings.");
	// Other channels are untouched.
	expect(screen.queryAllByText("Tests use the saved settings.")).toHaveLength(1);
});

test("email alerts turned off keep the mail server, which account email needs", async () => {
	const fetch = serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const box = await screen.findByRole("checkbox", { name: "Send alerts by email" });
	expect(description(box)).toBe("Sends each alert through the mail server above.");
	fireEvent.click(box);
	expect(screen.getByTestId("settings-mail-state").textContent).toBe(
		"1 unsaved change",
	);
	expect(description(box)).toContain("Not saved. Was on.");
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(1),
	);
	const update = sent(fetch, "/admin/notifications", "PUT")[0];
	expect(update.smtp).toMatchObject({ host: "smtp.example.edu" });
	expect(update.alerts.email).toBeNull();
	// Nothing was sent for account email, which did not change.
	expect(sent(fetch, "/admin/settings", "PUT")).toEqual([]);
});

test("a changed field says it is not saved, and never quotes a secret", async () => {
	serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	const host = await screen.findByLabelText("Host name");
	fireEvent.change(host, { target: { value: "mail.example.edu" } });
	expect(description(host).trim()).toBe("Not saved. Was smtp.example.edu.");
	const password = screen.getByLabelText("Password");
	fireEvent.change(password, { target: { value: "fake-password" } });
	expect(description(password).trim()).toMatch(/^Not saved\. Set\./);
	expect(document.body.textContent).not.toContain("fake-password");
	expect(screen.getByTestId("settings-mail-state").textContent).toBe(
		"2 unsaved changes",
	);

	fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
	expect((host as HTMLInputElement).value).toBe("smtp.example.edu");
	expect((password as HTMLInputElement).value).toBe("");
	expect(screen.getByTestId("settings-mail-state").textContent).toBe(
		"No unsaved changes.",
	);
});

test("account email saves first, then the rest, and says which part failed", async () => {
	const fetch = serve(
		{ settings: SETTINGS, job: null },
		{
			put: () =>
				json(409, {
					code: "NOTIFY_JOB_BUSY",
					message: "A notification settings change is already waiting or running.",
				}),
		},
	);
	renderWithQuery(<MailSection />);

	fireEvent.click(
		await screen.findByRole("checkbox", {
			name: "Email password reset and invitation links",
		}),
	);
	await changeSomething();
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(screen.getByTestId("settings-mail-state").textContent).toBe(
			"Not saved. Account email was saved, but the mail server and alert settings were not. A notification settings change is already waiting or running.",
		),
	);
	expect(sent(fetch, "/admin/settings", "PUT")).toEqual([
		{ accountEmailEnabled: true },
	]);
	// The part that failed stays unsaved.
	expect(box(/^Alert when a root shell opens/).checked).toBe(true);
});

test("account email alone saves without asking the alerts job", async () => {
	const fetch = serve({ settings: SETTINGS, job: null });
	renderWithQuery(<MailSection />);

	fireEvent.click(
		await screen.findByRole("checkbox", {
			name: "Email password reset and invitation links",
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(screen.getByTestId("settings-mail-state").textContent).toBe("Saved."),
	);
	expect(sent(fetch, "/admin/settings", "PUT")).toEqual([
		{ accountEmailEnabled: true },
	]);
	expect(sent(fetch, "/admin/notifications", "PUT")).toEqual([]);
});

test("secret fields ask the browser not to fill in a saved sign-in", async () => {
	serve({
		settings: {
			...SETTINGS,
			alerts: { ...SETTINGS.alerts, pushover: { userKeySet: true, appTokenSet: true } },
		},
		job: null,
	});
	renderWithQuery(<MailSection />);

	for (const label of ["Password", "User key", "API token", "Access token"]) {
		expect((await screen.findByLabelText(label)).getAttribute("autocomplete")).toBe(
			"new-password",
		);
	}
});

test("a busy answer is shown under the button", async () => {
	serve(
		{ settings: SETTINGS, job: null },
		{
			put: () =>
				json(409, {
					code: "NOTIFY_JOB_BUSY",
					message: "A notification settings change is already waiting or running.",
				}),
		},
	);
	renderWithQuery(<MailSection />);

	await changeSomething();
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(screen.getByTestId("settings-mail-state").textContent).toContain(
			"A notification settings change is already waiting or running.",
		),
	);
});

test("while a job waits, Save is unavailable and says why", async () => {
	const fetch = serve({ settings: SETTINGS, job: job() });
	renderWithQuery(<MailSection />);

	await changeSomething();
	const save = screen.getByRole("button", { name: "Save email and alerts" });
	expect(save.getAttribute("aria-disabled")).toBe("true");
	expect(description(save)).toMatch(/A change is being applied/);
	expect(screen.getByTestId("notify-job").textContent).toContain(
		"Saving. Waiting for the server",
	);
	fireEvent.click(save);
	expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(0);
});

test("a refused job says why in plain words", async () => {
	serve({
		settings: SETTINGS,
		job: job({
			state: "refused",
			code: "missing_secret",
			finishedAt: "2026-10-06T10:00:05.000Z",
		}),
	});
	renderWithQuery(<MailSection />);

	expect((await screen.findByTestId("notify-job")).textContent).toContain(
		"Not saved. A channel was turned on without its key or URL",
	);
});

test("Send test goes to that saved channel only, and says what happened", async () => {
	const fetch = serve(
		{ settings: SETTINGS, job: null },
		{
			tested: () =>
				json(200, {
					results: [{ channel: "webhook", ok: false, error: "unreachable" }],
				}),
		},
	);
	renderWithQuery(<MailSection />);

	const webhook = await screen.findByTestId("notify-webhook");
	fireEvent.click(
		within(webhook).getByRole("button", { name: "Send test to the webhook" }),
	);
	expect(
		(await within(webhook).findByTestId("notify-webhook-test-result")).textContent,
	).toContain("Not sent: this server could not reach it.");
	expect(sent(fetch, "/admin/alerts/test", "POST")).toEqual([{ channel: "webhook" }]);
	// An unsaved channel offers no test.
	expect(
		within(screen.getByTestId("notify-pushover")).queryByRole("button"),
	).toBeNull();
});

test("a job queued long ago is shown as not finished, and Save is offered again", async () => {
	const fetch = serve({
		settings: SETTINGS,
		job: job({ requestedAt: new Date(Date.now() - 6 * 60_000).toISOString() }),
	});
	renderWithQuery(<MailSection />);

	await changeSomething();
	const save = screen.getByRole("button", { name: "Save email and alerts" });
	expect(screen.getByTestId("notify-job").textContent).toContain(
		"The last change did not finish",
	);
	expect(save.getAttribute("aria-disabled")).toBeNull();
	fireEvent.click(save);
	await waitFor(() =>
		expect(sent(fetch, "/admin/notifications", "PUT")).toHaveLength(1),
	);
});

test("too many tests in a minute says to wait", async () => {
	serve(
		{ settings: SETTINGS, job: null },
		{
			tested: () =>
				json(429, {
					code: "RATE_LIMITED",
					message: "Too many requests just now. Try again in a minute.",
				}),
		},
	);
	renderWithQuery(<MailSection />);

	const webhook = await screen.findByTestId("notify-webhook");
	fireEvent.click(
		within(webhook).getByRole("button", { name: "Send test to the webhook" }),
	);
	await waitFor(() =>
		expect(within(webhook).getByTestId("notify-webhook-test-result").textContent).toBe(
			"Not sent: too many test alerts just now. Try again in a minute.",
		),
	);
});

test("after a save the page follows its own job, though the API still reports a dead one", async () => {
	const dead = job({
		id: "44444444-4444-4444-8444-444444444444",
		requestedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
	});
	serve(
		{ settings: SETTINGS, job: dead },
		{ put: () => json(202, job({ requestedAt: new Date().toISOString() })) },
	);
	renderWithQuery(<MailSection />);

	await changeSomething();
	fireEvent.click(screen.getByRole("button", { name: "Save email and alerts" }));
	await waitFor(() =>
		expect(screen.getByTestId("notify-job").textContent).toContain(
			"Saving. Waiting for the server",
		),
	);
});
