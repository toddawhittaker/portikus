import {
	isNotifyJobActive,
	NOTIFY_FILE_OFF,
	type NotificationSettingsView,
	NotifyJobCode,
	type NotifyJobView,
	notificationSettingsView,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	CODE_TEXT,
	FIELD_ID,
	initialForm,
	isStale,
	jobText,
	type NotifyForm,
	ntfyTokenCleared,
	recipients,
	STALE_TEXT,
	smtpPasswordCleared,
	toUpdate,
	validate,
} from "./form.js";

const OFF = notificationSettingsView(NOTIFY_FILE_OFF);

/** Every channel saved, with every secret set. */
const ALL: NotificationSettingsView = {
	smtp: {
		host: "smtp.example.edu",
		port: 587,
		username: "portikus",
		passwordSet: true,
		from: "Portikus <portikus@example.edu>",
	},
	alerts: {
		email: { to: ["ops@example.edu", "dean@example.edu"] },
		pushover: { userKeySet: true, appTokenSet: true },
		webhook: { host: "hooks.slack.com", urlSet: true },
		ntfy: { host: "ntfy.sh", urlSet: true, tokenSet: true },
		teams: { host: "example.webhook.office.com", urlSet: true },
	},
	rootShellOpenedAlert: true,
};

function edit(view: NotificationSettingsView, change: (form: NotifyForm) => void) {
	const form = structuredClone(initialForm(view));
	change(form);
	return form;
}

describe("initialForm", () => {
	test("a missing file is every channel off and the root-shell alert off", () => {
		const form = initialForm(OFF);
		expect([
			form.email.on,
			form.pushover.on,
			form.ntfy.on,
			form.teams.on,
			form.webhook.on,
		]).toEqual([false, false, false, false, false]);
		expect(form.rootShellOpenedAlert).toBe(false);
		expect(form.email.port).toBe("587");
	});

	test("saved settings fill the plain fields and leave every secret blank", () => {
		const form = initialForm(ALL);
		expect(form.email).toMatchObject({
			on: true,
			host: "smtp.example.edu",
			username: "portikus",
			password: "",
			to: "ops@example.edu\ndean@example.edu",
		});
		expect(form.pushover).toEqual({ on: true, userKey: "", appToken: "" });
		expect(form.ntfy).toEqual({ on: true, url: "", token: "", removeToken: false });
		expect(form.teams.url).toBe("");
		expect(form.webhook.url).toBe("");
		expect(form.rootShellOpenedAlert).toBe(true);
	});
});

describe("toUpdate", () => {
	test("unchanged saved settings send no secret, so every stored one is kept", () => {
		const update = toUpdate(initialForm(ALL));
		expect(update.smtp).toEqual({
			host: "smtp.example.edu",
			port: 587,
			username: "portikus",
			from: "Portikus <portikus@example.edu>",
		});
		expect(update.alerts).toEqual({
			email: { to: ["ops@example.edu", "dean@example.edu"] },
			pushover: {},
			ntfy: {},
			teams: {},
			webhook: {},
		});
		expect(update.rootShellOpenedAlert).toBe(true);
	});

	test("a channel turned off is null; email off also turns the mail server off", () => {
		const update = toUpdate(
			edit(ALL, (f) => {
				f.email.on = false;
				f.webhook.on = false;
				f.rootShellOpenedAlert = false;
			}),
		);
		expect(update.smtp).toBeNull();
		expect(update.alerts.email).toBeNull();
		expect(update.alerts.webhook).toBeNull();
		expect(update.rootShellOpenedAlert).toBe(false);
	});

	test("typed secrets are sent, trimmed where spaces cannot belong", () => {
		const update = toUpdate(
			edit(OFF, (f) => {
				f.pushover = { on: true, userKey: " u123 ", appToken: "a456" };
				f.webhook = { on: true, url: " https://hooks.example.com/x " };
				f.email = {
					on: true,
					host: "smtp.example.edu",
					port: "465",
					username: "me",
					password: " pass with spaces ",
					from: "me@example.edu",
					to: "a@example.edu, b@example.edu\n\n",
				};
			}),
		);
		expect(update.alerts.pushover).toEqual({ userKey: "u123", appToken: "a456" });
		expect(update.alerts.webhook).toEqual({ url: "https://hooks.example.com/x" });
		expect(update.smtp).toMatchObject({ port: 465, password: " pass with spaces " });
		expect(update.alerts.email).toEqual({ to: ["a@example.edu", "b@example.edu"] });
	});

	test("a blank SMTP user name sends an empty password, since nothing signs in", () => {
		const update = toUpdate(edit(ALL, (f) => (f.email.username = "")));
		expect(update.smtp?.password).toBe("");
	});

	test("Remove the stored token sends an empty ntfy token", () => {
		const update = toUpdate(edit(ALL, (f) => (f.ntfy.removeToken = true)));
		expect(update.alerts.ntfy).toEqual({ token: "" });
	});
});

describe("host changes clear secrets (ADR 0052)", () => {
	test("a new SMTP host, port or user name warns that the password goes", () => {
		expect(smtpPasswordCleared(initialForm(ALL), ALL)).toBe(false);
		// Host names are compared without case, as the root job does.
		expect(
			smtpPasswordCleared(
				edit(ALL, (f) => (f.email.host = "SMTP.example.edu")),
				ALL,
			),
		).toBe(false);
		for (const change of [
			(f: NotifyForm) => (f.email.host = "mail.example.edu"),
			(f: NotifyForm) => (f.email.port = "465"),
			(f: NotifyForm) => (f.email.username = "other"),
		]) {
			expect(smtpPasswordCleared(edit(ALL, change), ALL)).toBe(true);
		}
		// Not when a new password comes with the change.
		expect(
			smtpPasswordCleared(
				edit(ALL, (f) => {
					f.email.host = "mail.example.edu";
					f.email.password = "new";
				}),
				ALL,
			),
		).toBe(false);
	});

	test("a cleared password must be entered again before saving", () => {
		const errors = validate(
			edit(ALL, (f) => (f.email.host = "mail.example.edu")),
			ALL,
		);
		expect(errors[FIELD_ID.smtpPassword]).toBe(
			"Enter the password for this user name.",
		);
	});

	test("an ntfy URL on another host warns that the token goes", () => {
		expect(
			ntfyTokenCleared(
				edit(ALL, (f) => (f.ntfy.url = "https://ntfy.sh/other")),
				ALL,
			),
		).toBe(false);
		expect(
			ntfyTokenCleared(
				edit(ALL, (f) => (f.ntfy.url = "https://ntfy.example.edu/alerts")),
				ALL,
			),
		).toBe(true);
		expect(
			ntfyTokenCleared(
				edit(ALL, (f) => {
					f.ntfy.url = "https://ntfy.example.edu/alerts";
					f.ntfy.token = "tk";
				}),
				ALL,
			),
		).toBe(false);
	});
});

describe("validate", () => {
	test("saved settings left as they are have no errors", () => {
		expect(validate(initialForm(ALL), ALL)).toEqual({});
		expect(validate(initialForm(OFF), OFF)).toEqual({});
	});

	test("a channel turned on with nothing stored needs its key or URL", () => {
		const errors = validate(
			edit(OFF, (f) => {
				f.email.on = true;
				f.pushover.on = true;
				f.ntfy.on = true;
				f.teams.on = true;
				f.webhook.on = true;
			}),
			OFF,
		);
		expect(Object.keys(errors)).toEqual([
			FIELD_ID.smtpHost,
			FIELD_ID.smtpFrom,
			FIELD_ID.emailTo,
			FIELD_ID.pushoverUserKey,
			FIELD_ID.pushoverAppToken,
			FIELD_ID.ntfyUrl,
			FIELD_ID.teamsUrl,
			FIELD_ID.webhookUrl,
		]);
	});

	test("the contract's rules land on their fields in plain words", () => {
		const errors = validate(
			edit(ALL, (f) => {
				f.email.host = "192.0.2.1";
				f.email.to = "not-an-address";
				f.pushover.userKey = "has spaces";
				f.webhook.url = "http://hooks.example.com/x";
				f.teams.url = "https://example.com:8443/x";
			}),
			ALL,
		);
		expect(errors[FIELD_ID.smtpHost]).toMatch(/An IP address does not work/);
		expect(errors[FIELD_ID.emailTo]).toMatch(/one per line/);
		expect(errors[FIELD_ID.pushoverUserKey]).toMatch(/letters and digits only/);
		expect(errors[FIELD_ID.webhookUrl]).toMatch(/https address/);
		expect(errors[FIELD_ID.teamsUrl]).toMatch(/no port/);
	});

	test("more than ten recipients is refused", () => {
		const to = Array.from({ length: 11 }, (_, i) => `a${i}@example.edu`).join("\n");
		const errors = validate(
			edit(ALL, (f) => (f.email.to = to)),
			ALL,
		);
		expect(errors[FIELD_ID.emailTo]).toBe(
			"Enter 1 to 10 email addresses, one per line.",
		);
	});
});

test("recipients split on lines and commas and drop blanks", () => {
	expect(recipients(" a@x.edu ,b@x.edu\n\n c@x.edu ")).toEqual([
		"a@x.edu",
		"b@x.edu",
		"c@x.edu",
	]);
});

describe("jobText", () => {
	const job = (over: Partial<NotifyJobView>): NotifyJobView => ({
		id: "33333333-3333-4333-8333-333333333333",
		state: "queued",
		code: null,
		channels: [],
		hosts: [],
		requestedAt: null,
		startedAt: null,
		finishedAt: null,
		...over,
	});

	test("every fixed code has a sentence that never quotes the server", () => {
		for (const code of NotifyJobCode.options) {
			expect(CODE_TEXT[code]).toMatch(/\.$/);
		}
	});

	test("says where the job is, and why it stopped", () => {
		expect(jobText(job({ state: "queued" }))).toMatch(/^Saving\./);
		expect(jobText(job({ state: "running" }))).toMatch(/^Saving\./);
		expect(jobText(job({ state: "succeeded" }))).toBe(
			"Saved. The new settings are in use.",
		);
		expect(jobText(job({ state: "refused", code: "invalid_teams" }))).toBe(
			`Not saved. ${CODE_TEXT.invalid_teams}`,
		);
		expect(jobText(job({ state: "failed", code: "proxy_reload_failed" }))).toBe(
			CODE_TEXT.proxy_reload_failed,
		);
	});
});

describe("a job that never finishes", () => {
	const at = Date.parse("2026-10-06T10:00:00.000Z");
	const job = (over: Partial<NotifyJobView>): NotifyJobView => ({
		id: "33333333-3333-4333-8333-333333333333",
		state: "queued",
		code: null,
		channels: [],
		hosts: [],
		requestedAt: "2026-10-06T10:00:00.000Z",
		startedAt: null,
		finishedAt: null,
		...over,
	});

	test("blocks a save for five minutes from queueing or starting, then says it did not finish", () => {
		const queued = job({});
		expect(isNotifyJobActive(queued, at + 4 * 60_000)).toBe(true);
		expect(isNotifyJobActive(queued, at + 5 * 60_000)).toBe(false);
		expect(isStale(queued, at + 5 * 60_000)).toBe(true);
		expect(jobText(queued, at + 6 * 60_000)).toBe(STALE_TEXT);

		// A running job counts from when it started.
		const running = job({ state: "running", startedAt: "2026-10-06T10:04:00.000Z" });
		expect(isNotifyJobActive(running, at + 6 * 60_000)).toBe(true);
		expect(isStale(running, at + 10 * 60_000)).toBe(true);
	});

	test("a finished job is never stale, and an unknown time never goes stale", () => {
		expect(isStale(job({ state: "succeeded" }), at + 60 * 60_000)).toBe(false);
		expect(isNotifyJobActive(job({ requestedAt: null }), at + 60 * 60_000)).toBe(true);
	});
});
