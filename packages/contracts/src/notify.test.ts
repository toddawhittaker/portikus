import { describe, expect, test } from "vitest";
import {
	NOTIFY_FILE_OFF,
	NotificationSettingsUpdate,
	NotificationSettingsView,
	NotifyFile,
	notificationSettingsView,
} from "./notify.js";

const smtp = {
	host: "smtp.example.edu",
	port: 587,
	username: "portikus",
	password: "smtp-secret",
	from: "Portikus <portikus@example.edu>",
};

const full = {
	version: 1,
	smtp,
	alerts: {
		email: { to: ["ops@example.edu"] },
		pushover: { userKey: "ukeysecret", appToken: "atoksecret" },
		webhook: { url: "https://hooks.example.com/services/hook-secret" },
		ntfy: { url: "https://ntfy.sh/topic-secret", token: "tk-secret" },
		teams: { url: "https://teams.example.com/workflows/teams-secret" },
	},
	rootShellOpenedAlert: true,
};

describe("NotifyFile", () => {
	test("accepts a full version 1 file and the all-off file", () => {
		expect(NotifyFile.parse(full)).toEqual(full);
		expect(NotifyFile.parse(NOTIFY_FILE_OFF)).toEqual(NOTIFY_FILE_OFF);
	});

	test("rootShellOpenedAlert defaults to false", () => {
		const { rootShellOpenedAlert: _, ...rest } = full;
		expect(NotifyFile.parse(rest).rootShellOpenedAlert).toBe(false);
		expect(NOTIFY_FILE_OFF.rootShellOpenedAlert).toBe(false);
	});

	test("SMTP takes only ports 587 and 465", () => {
		for (const port of [587, 465]) {
			expect(NotifyFile.safeParse({ ...full, smtp: { ...smtp, port } }).success).toBe(
				true,
			);
		}
		for (const port of [25, 2525, 0]) {
			expect(NotifyFile.safeParse({ ...full, smtp: { ...smtp, port } }).success).toBe(
				false,
			);
		}
	});

	test("alert email needs SMTP settings", () => {
		expect(NotifyFile.safeParse({ ...full, smtp: null }).success).toBe(false);
		const noEmail = { ...full, smtp: null, alerts: { ...full.alerts, email: null } };
		expect(NotifyFile.safeParse(noEmail).success).toBe(true);
	});

	test("recipients are an explicit list of one to ten addresses", () => {
		const withTo = (to: string[]) => ({
			...full,
			alerts: { ...full.alerts, email: { to } },
		});
		expect(NotifyFile.safeParse(withTo([])).success).toBe(false);
		expect(NotifyFile.safeParse(withTo(["not an address"])).success).toBe(false);
		const eleven = Array.from({ length: 11 }, (_, i) => `a${i}@example.edu`);
		expect(NotifyFile.safeParse(withTo(eleven)).success).toBe(false);
		expect(NotifyFile.safeParse(withTo(eleven.slice(0, 10))).success).toBe(true);
	});

	// The egress proxy opens only port 443 for alert hosts (ADR 0052).
	test("alert URLs are https on the default port with no credentials", () => {
		const withTeams = (url: string) => ({
			...full,
			alerts: { ...full.alerts, teams: { url } },
		});
		for (const url of [
			"http://teams.example.com/x",
			"https://teams.example.com:8443/x",
			"https://user:pass@teams.example.com/x",
			"not a url",
		]) {
			expect(NotifyFile.safeParse(withTeams(url)).success, url).toBe(false);
		}
		expect(
			NotifyFile.safeParse(withTeams("https://teams.example.com:443/x")).success,
		).toBe(true);
	});

	test("rejects unknown keys, other versions and bad host names", () => {
		expect(NotifyFile.safeParse({ ...full, extra: 1 }).success).toBe(false);
		expect(NotifyFile.safeParse({ ...full, version: 2 }).success).toBe(false);
		expect(
			NotifyFile.safeParse({ ...full, smtp: { ...smtp, host: "smtp.example.edu; rm" } })
				.success,
		).toBe(false);
	});
});

describe("the settings view", () => {
	test("carries no secret, only whether each is set", () => {
		const view = notificationSettingsView(NotifyFile.parse(full));
		expect(NotificationSettingsView.parse(view)).toEqual(view);
		const text = JSON.stringify(view);
		for (const secret of [
			"smtp-secret",
			"ukeysecret",
			"atoksecret",
			"hook-secret",
			"topic-secret",
			"tk-secret",
			"teams-secret",
		]) {
			expect(text, secret).not.toContain(secret);
		}
		expect(view.smtp?.passwordSet).toBe(true);
		expect(view.alerts.webhook).toEqual({ host: "hooks.example.com", urlSet: true });
		expect(view.alerts.ntfy).toEqual({ host: "ntfy.sh", urlSet: true, tokenSet: true });
		expect(view.alerts.email).toEqual({ to: ["ops@example.edu"] });
		expect(view.rootShellOpenedAlert).toBe(true);
	});

	test("an empty password or token reads as not set; off channels stay null", () => {
		const view = notificationSettingsView(NOTIFY_FILE_OFF);
		expect(view.smtp).toBeNull();
		expect(Object.values(view.alerts).every((v) => v === null)).toBe(true);
		const noPassword = notificationSettingsView(
			NotifyFile.parse({ ...full, smtp: { ...smtp, username: "", password: "" } }),
		);
		expect(noPassword.smtp?.passwordSet).toBe(false);
	});
});

describe("the settings update", () => {
	test("leaving secrets out keeps the stored ones", () => {
		const update = {
			smtp: { ...smtp, password: undefined },
			alerts: {
				email: { to: ["ops@example.edu"] },
				pushover: {},
				webhook: {},
				ntfy: { token: undefined },
				teams: {},
			},
			rootShellOpenedAlert: false,
		};
		expect(NotificationSettingsUpdate.safeParse(update).success).toBe(true);
	});

	test("applies the same port and email rules as the file", () => {
		const base = {
			smtp,
			alerts: { email: null, pushover: null, webhook: null, ntfy: null, teams: null },
			rootShellOpenedAlert: false,
		};
		expect(NotificationSettingsUpdate.safeParse(base).success).toBe(true);
		expect(
			NotificationSettingsUpdate.safeParse({ ...base, smtp: { ...smtp, port: 25 } })
				.success,
		).toBe(false);
		expect(
			NotificationSettingsUpdate.safeParse({
				...base,
				smtp: null,
				alerts: { ...base.alerts, email: { to: ["a@example.edu"] } },
			}).success,
		).toBe(false);
	});
});
