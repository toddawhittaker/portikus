import {
	type AlertChannelKind,
	MAX_ALERT_EMAIL_RECIPIENTS,
	NOTIFY_JOB_STALE_MS,
	type NotificationSettingsUpdate,
	type NotificationSettingsView,
	type NotifyJobCode,
	type NotifyJobView,
	NotificationSettingsUpdate as UpdateSchema,
} from "@portikus/contracts";

/**
 * The Notifications form (ADR 0052): what the page holds while editing, how
 * it becomes a `NotificationSettingsUpdate`, and the sentences it shows.
 * Secret fields start blank; a blank secret is left out of the update, so
 * the stored one is kept.
 */

export type SmtpPort = "587" | "465";

export interface NotifyForm {
	email: {
		on: boolean;
		host: string;
		port: SmtpPort;
		username: string;
		password: string;
		from: string;
		/** One address per line; commas also separate. */
		to: string;
	};
	pushover: { on: boolean; userKey: string; appToken: string };
	ntfy: { on: boolean; url: string; token: string; removeToken: boolean };
	teams: { on: boolean; url: string };
	webhook: { on: boolean; url: string };
	rootShellOpenedAlert: boolean;
}

/** The order the page lists the channels in. */
export const CHANNELS: AlertChannelKind[] = [
	"email",
	"pushover",
	"ntfy",
	"teams",
	"webhook",
];

export const CHANNEL_NAME: Record<AlertChannelKind, string> = {
	email: "Email",
	pushover: "Pushover",
	ntfy: "ntfy",
	teams: "Microsoft Teams",
	webhook: "Webhook",
};

/** Each field's element id; errors are keyed by it so the first can take focus. */
export const FIELD_ID = {
	smtpHost: "notify-smtp-host",
	smtpUsername: "notify-smtp-username",
	smtpPassword: "notify-smtp-password",
	smtpFrom: "notify-smtp-from",
	emailTo: "notify-email-to",
	pushoverUserKey: "notify-pushover-user-key",
	pushoverAppToken: "notify-pushover-app-token",
	ntfyUrl: "notify-ntfy-url",
	ntfyToken: "notify-ntfy-token",
	teamsUrl: "notify-teams-url",
	webhookUrl: "notify-webhook-url",
} as const;
type FieldId = (typeof FIELD_ID)[keyof typeof FIELD_ID];

export type FormErrors = Partial<Record<FieldId, string>>;

/** The form for the settings in force; every secret field blank. */
export function initialForm(view: NotificationSettingsView): NotifyForm {
	const { smtp, alerts } = view;
	return {
		email: {
			on: alerts.email !== null,
			host: smtp?.host ?? "",
			port: smtp?.port === 465 ? "465" : "587",
			username: smtp?.username ?? "",
			password: "",
			from: smtp?.from ?? "",
			to: alerts.email?.to.join("\n") ?? "",
		},
		pushover: { on: alerts.pushover !== null, userKey: "", appToken: "" },
		ntfy: { on: alerts.ntfy !== null, url: "", token: "", removeToken: false },
		teams: { on: alerts.teams !== null, url: "" },
		webhook: { on: alerts.webhook !== null, url: "" },
		rootShellOpenedAlert: view.rootShellOpenedAlert,
	};
}

export function recipients(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/**
 * The root job clears the stored SMTP password when the host, port or user
 * name changes and no new one comes with it (ADR 0052).
 */
export function smtpPasswordCleared(form: NotifyForm, view: NotificationSettingsView) {
	const stored = view.smtp;
	const { email } = form;
	if (!stored?.passwordSet || !email.on || email.password !== "") return false;
	if (email.username.trim() === "") return false;
	return (
		email.host.trim().toLowerCase() !== stored.host.toLowerCase() ||
		Number(email.port) !== stored.port ||
		email.username.trim() !== stored.username
	);
}

/** The root job clears the stored ntfy token when the topic URL moves to another host. */
export function ntfyTokenCleared(form: NotifyForm, view: NotificationSettingsView) {
	const stored = view.alerts.ntfy;
	const { ntfy } = form;
	if (!stored?.tokenSet || !ntfy.on || ntfy.token !== "" || ntfy.removeToken)
		return false;
	const host = hostOf(ntfy.url.trim());
	return host !== null && host !== stored.host;
}

/** The update to send. Only call it once `validate` found nothing. */
export function toUpdate(form: NotifyForm): NotificationSettingsUpdate {
	const { email, pushover, ntfy, teams, webhook } = form;
	const typed = (value: string) => (value === "" ? {} : { value });
	const username = email.username.trim();
	// With no user name nothing is signed in, so any stored password goes.
	const password =
		email.password !== "" ? email.password : username === "" ? "" : undefined;
	const ntfyToken = ntfy.token !== "" ? ntfy.token : ntfy.removeToken ? "" : undefined;
	return {
		smtp: email.on
			? {
					host: email.host.trim(),
					port: email.port === "465" ? 465 : 587,
					username,
					...(password === undefined ? {} : { password }),
					from: email.from.trim(),
				}
			: null,
		alerts: {
			email: email.on ? { to: recipients(email.to) } : null,
			pushover: pushover.on
				? {
						...withKey("userKey", typed(pushover.userKey.trim())),
						...withKey("appToken", typed(pushover.appToken.trim())),
					}
				: null,
			ntfy: ntfy.on
				? {
						...withKey("url", typed(ntfy.url.trim())),
						...(ntfyToken === undefined ? {} : { token: ntfyToken }),
					}
				: null,
			teams: teams.on ? withKey("url", typed(teams.url.trim())) : null,
			webhook: webhook.on ? withKey("url", typed(webhook.url.trim())) : null,
		},
		rootShellOpenedAlert: form.rootShellOpenedAlert,
	};
}

function withKey<K extends string>(key: K, part: { value?: string }) {
	return (part.value === undefined ? {} : { [key]: part.value }) as Partial<
		Record<K, string>
	>;
}

const URL_RULE =
	"Enter an https address with a host name and no port, such as https://example.com/path.";

/** The field each update path belongs to, and what to say when it is refused. */
const PATH_FIELD: Record<string, { id: FieldId; text: string }> = {
	"smtp.host": {
		id: FIELD_ID.smtpHost,
		text: "Enter the server's host name, such as smtp.example.edu. An IP address does not work.",
	},
	"smtp.username": {
		id: FIELD_ID.smtpUsername,
		text: "Use at most 200 characters, with no line breaks.",
	},
	"smtp.password": { id: FIELD_ID.smtpPassword, text: "Use at most 500 characters." },
	"smtp.from": {
		id: FIELD_ID.smtpFrom,
		text: "Enter the sender, such as Portikus <portikus@example.edu>, in at most 200 characters.",
	},
	"alerts.email.to": {
		id: FIELD_ID.emailTo,
		text: `Enter 1 to ${MAX_ALERT_EMAIL_RECIPIENTS} email addresses, one per line.`,
	},
	"alerts.pushover.userKey": {
		id: FIELD_ID.pushoverUserKey,
		text: "Enter the user key as Pushover shows it: letters and digits only.",
	},
	"alerts.pushover.appToken": {
		id: FIELD_ID.pushoverAppToken,
		text: "Enter the API token as Pushover shows it: letters and digits only.",
	},
	"alerts.ntfy.url": { id: FIELD_ID.ntfyUrl, text: URL_RULE },
	"alerts.ntfy.token": { id: FIELD_ID.ntfyToken, text: "Use at most 500 characters." },
	"alerts.teams.url": { id: FIELD_ID.teamsUrl, text: URL_RULE },
	"alerts.webhook.url": { id: FIELD_ID.webhookUrl, text: URL_RULE },
};

/** The field a refused path names, matched on its longest known prefix. */
function fieldFor(path: string): { id: FieldId; text: string } | null {
	const parts = path.split(".");
	while (parts.length > 0) {
		const found = PATH_FIELD[parts.join(".")];
		if (found) return found;
		parts.pop();
	}
	return null;
}

/** What is wrong with the form, by field id, in the order the page shows them. */
export function validate(form: NotifyForm, view: NotificationSettingsView): FormErrors {
	const found: FormErrors = {};
	const need = (id: FieldId, text: string) => {
		found[id] ??= text;
	};
	const { email, pushover, ntfy, teams, webhook } = form;
	const { alerts } = view;
	if (email.on) {
		if (email.host.trim() === "")
			need(FIELD_ID.smtpHost, "Enter the mail server's host name.");
		const username = email.username.trim();
		const stored = view.smtp?.passwordSet === true && !smtpPasswordCleared(form, view);
		if (username !== "" && email.password === "" && !stored) {
			need(FIELD_ID.smtpPassword, "Enter the password for this user name.");
		}
		if (email.from.trim() === "") need(FIELD_ID.smtpFrom, "Enter the sender address.");
		const to = recipients(email.to);
		if (to.length === 0)
			need(FIELD_ID.emailTo, "Enter at least one address to send alerts to.");
	}
	if (pushover.on) {
		if (pushover.userKey.trim() === "" && !alerts.pushover?.userKeySet) {
			need(FIELD_ID.pushoverUserKey, "Enter your Pushover user key.");
		}
		if (pushover.appToken.trim() === "" && !alerts.pushover?.appTokenSet) {
			need(
				FIELD_ID.pushoverAppToken,
				"Enter the API token of your Pushover application.",
			);
		}
	}
	if (ntfy.on && ntfy.url.trim() === "" && !alerts.ntfy?.urlSet) {
		need(FIELD_ID.ntfyUrl, "Enter the topic URL.");
	}
	if (teams.on && teams.url.trim() === "" && !alerts.teams?.urlSet) {
		need(FIELD_ID.teamsUrl, "Enter the Workflows webhook URL.");
	}
	if (webhook.on && webhook.url.trim() === "" && !alerts.webhook?.urlSet) {
		need(FIELD_ID.webhookUrl, "Enter the webhook URL.");
	}
	const parsed = UpdateSchema.safeParse(toUpdate(form));
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const field = fieldFor(issue.path.join("."));
			if (field) need(field.id, field.text);
		}
	}
	return ordered(found);
}

const FIELD_ORDER = Object.values(FIELD_ID);

function ordered(found: FormErrors): FormErrors {
	const out: FormErrors = {};
	for (const id of FIELD_ORDER) {
		const text = found[id];
		if (text) out[id] = text;
	}
	return out;
}

/** What a finished job's fixed code means, and what to do next. */
export const CODE_TEXT: Record<NotifyJobCode, string> = {
	invalid_request:
		"The server could not read the change. Nothing changed. Reload the page and save again.",
	invalid_smtp:
		"The server refused the mail server settings. Nothing changed. Check the host name, port, user name and sender.",
	invalid_email: `The server refused the alert email list. Nothing changed. Enter 1 to ${MAX_ALERT_EMAIL_RECIPIENTS} addresses.`,
	invalid_pushover:
		"The server refused the Pushover keys. Nothing changed. Check both keys.",
	invalid_webhook:
		"The server refused the webhook URL. Nothing changed. Use an https address with a host name and no port.",
	invalid_ntfy:
		"The server refused the ntfy settings. Nothing changed. Use an https topic URL with a host name and no port.",
	invalid_teams:
		"The server refused the Teams URL. Nothing changed. Use an https address with a host name and no port.",
	email_needs_smtp:
		"Alert email needs a mail server. Nothing changed. Fill in the mail server.",
	missing_secret:
		"A channel was turned on without its key or URL, and none is stored. Nothing changed. Enter it and save again.",
	proxy_config_rejected:
		"The outbound proxy refused the new alert hosts, so nothing changed. Check the host names.",
	proxy_reload_failed:
		"The settings were saved, but the outbound proxy did not reload, so alerts to a new host are blocked until it does. Run sudo systemctl reload squid on the server.",
	write_failed:
		"The server could not write the settings file. Nothing changed. Look for portikus-alerts-job in the server's journal.",
};

/**
 * When an unfinished job counts as dead, as the API decides it: from the
 * time it started running, or else the time it was queued. Null for a
 * finished job; NaN when the time is unknown, which never goes stale.
 */
export function staleAt(job: NotifyJobView | null | undefined): number | null {
	if (job?.state !== "queued" && job?.state !== "running") return null;
	const since = job.state === "running" ? job.startedAt : job.requestedAt;
	return since ? Date.parse(since) + NOTIFY_JOB_STALE_MS : Number.NaN;
}

/** Queued or running, and not yet stale: a save waits for it. */
export function isActive(
	job: NotifyJobView | null | undefined,
	now: number = Date.now(),
): boolean {
	const at = staleAt(job);
	return at !== null && (Number.isNaN(at) || now < at);
}

/** Queued or running for longer than any job takes: it will not finish. */
export function isStale(
	job: NotifyJobView | null | undefined,
	now: number = Date.now(),
): boolean {
	return staleAt(job) !== null && !isActive(job, now);
}

export const STALE_TEXT =
	"The last change did not finish, so it may not be in use. Save again. If it stops again, look for portikus-alerts-job in the server's journal.";

/** One line on the latest save, for the page and its status region. */
export function jobText(job: NotifyJobView, now: number = Date.now()): string {
	if (isStale(job, now)) return STALE_TEXT;
	switch (job.state) {
		case "queued":
			return "Saving. Waiting for the server to apply the change.";
		case "running":
			return "Saving. The server is applying the change.";
		case "succeeded":
			return "Saved. The new settings are in use.";
		default: {
			const reason = job.code ? CODE_TEXT[job.code] : "Nothing changed. Save again.";
			// A failed job's text says itself whether anything was saved.
			return job.state === "refused" ? `Not saved. ${reason}` : reason;
		}
	}
}
