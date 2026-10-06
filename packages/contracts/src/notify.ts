import { z } from "zod";

/**
 * The notification settings file, `/etc/portikus/notify.json` (ADR 0052,
 * version 1). Each block may be null, meaning off. The root alerts job
 * validates the same rules independently before writing the file.
 */

// The egress proxy opens only port 443 for alert hosts (ADR 0052).
const AlertUrl = z
	.string()
	.url()
	.max(500)
	.refine((url) => {
		try {
			const parsed = new URL(url);
			return (
				parsed.protocol === "https:" && parsed.port === "" && parsed.username === ""
			);
		} catch {
			return false;
		}
	}, "must be an https URL on the default port");

const HostName = z
	.string()
	.max(253)
	.regex(
		/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/,
		"must be a host name",
	);

// Pushover keys are 30 letters and digits; the check only keeps quotes and spaces out.
const PushoverKey = z.string().regex(/^[A-Za-z0-9]{1,100}$/);

export const MAX_ALERT_EMAIL_RECIPIENTS = 10;

const Secret = z.string().max(500);

export const NotifySmtp = z
	.object({
		host: HostName,
		/** 587 is STARTTLS and 465 implicit TLS; TLS is required on both (ADR 0052). */
		port: z.union([z.literal(587), z.literal(465)]),
		/** Empty means the server takes mail without signing in. */
		username: z.string().max(200),
		password: Secret,
		from: z.string().min(1).max(200),
	})
	.strict();
export type NotifySmtp = z.infer<typeof NotifySmtp>;

export const NotifyAlerts = z
	.object({
		email: z
			.object({
				to: z.array(z.string().email().max(200)).min(1).max(MAX_ALERT_EMAIL_RECIPIENTS),
			})
			.strict()
			.nullable(),
		pushover: z
			.object({ userKey: PushoverKey, appToken: PushoverKey })
			.strict()
			.nullable(),
		webhook: z.object({ url: AlertUrl }).strict().nullable(),
		/** An empty token means the topic needs none. */
		ntfy: z.object({ url: AlertUrl, token: Secret }).strict().nullable(),
		teams: z.object({ url: AlertUrl }).strict().nullable(),
	})
	.strict();
export type NotifyAlerts = z.infer<typeof NotifyAlerts>;

export const NotifyFile = z
	.object({
		version: z.literal(1),
		smtp: NotifySmtp.nullable(),
		alerts: NotifyAlerts,
		/** The site alert when a root shell opens (ADR 0051); off when missing. */
		rootShellOpenedAlert: z.boolean().default(false),
	})
	.strict()
	.refine((file) => file.alerts.email === null || file.smtp !== null, {
		message: "alert email needs the SMTP settings",
		path: ["alerts", "email"],
	});
export type NotifyFile = z.infer<typeof NotifyFile>;

/** Everything off: what a missing file means. */
export const NOTIFY_FILE_OFF: NotifyFile = {
	version: 1,
	smtp: null,
	alerts: { email: null, pushover: null, webhook: null, ntfy: null, teams: null },
	rootShellOpenedAlert: false,
};

// ---- The page's view: never a secret, only whether one is set ----

export const NotificationSettingsView = z
	.object({
		smtp: z
			.object({
				host: z.string(),
				port: z.number().int(),
				username: z.string(),
				passwordSet: z.boolean(),
				from: z.string(),
			})
			.strict()
			.nullable(),
		alerts: z
			.object({
				email: z
					.object({ to: z.array(z.string()) })
					.strict()
					.nullable(),
				pushover: z
					.object({ userKeySet: z.boolean(), appTokenSet: z.boolean() })
					.strict()
					.nullable(),
				/** Webhook URLs carry their secret in the path, so they are write-only too. */
				webhook: z
					.object({ host: z.string(), urlSet: z.boolean() })
					.strict()
					.nullable(),
				/** An ntfy.sh topic name is as good as a password, so its URL is write-only. */
				ntfy: z
					.object({ host: z.string(), urlSet: z.boolean(), tokenSet: z.boolean() })
					.strict()
					.nullable(),
				teams: z.object({ host: z.string(), urlSet: z.boolean() }).strict().nullable(),
			})
			.strict(),
		rootShellOpenedAlert: z.boolean(),
	})
	.strict();
export type NotificationSettingsView = z.infer<typeof NotificationSettingsView>;

// ---- An update: a secret left out keeps the stored one ----

export const NotificationSettingsUpdate = z
	.object({
		smtp: NotifySmtp.extend({ password: Secret.optional() }).strict().nullable(),
		alerts: z
			.object({
				email: NotifyAlerts.shape.email,
				pushover: z
					.object({ userKey: PushoverKey.optional(), appToken: PushoverKey.optional() })
					.strict()
					.nullable(),
				webhook: z.object({ url: AlertUrl.optional() }).strict().nullable(),
				ntfy: z
					.object({ url: AlertUrl.optional(), token: Secret.optional() })
					.strict()
					.nullable(),
				teams: z.object({ url: AlertUrl.optional() }).strict().nullable(),
			})
			.strict(),
		rootShellOpenedAlert: z.boolean(),
	})
	.strict()
	.refine((update) => update.alerts.email === null || update.smtp !== null, {
		message: "alert email needs the SMTP settings",
		path: ["alerts", "email"],
	});
export type NotificationSettingsUpdate = z.infer<typeof NotificationSettingsUpdate>;

/** The view of a file: secrets become "is set" flags, secret URLs only their host. */
export function notificationSettingsView(file: NotifyFile): NotificationSettingsView {
	const { smtp, alerts } = file;
	const host = (url: string) => new URL(url).hostname;
	return {
		smtp: smtp && {
			host: smtp.host,
			port: smtp.port,
			username: smtp.username,
			passwordSet: smtp.password !== "",
			from: smtp.from,
		},
		alerts: {
			email: alerts.email && { to: [...alerts.email.to] },
			pushover: alerts.pushover && {
				userKeySet: alerts.pushover.userKey !== "",
				appTokenSet: alerts.pushover.appToken !== "",
			},
			webhook: alerts.webhook && { host: host(alerts.webhook.url), urlSet: true },
			ntfy: alerts.ntfy && {
				host: host(alerts.ntfy.url),
				urlSet: true,
				tokenSet: alerts.ntfy.token !== "",
			},
			teams: alerts.teams && { host: host(alerts.teams.url), urlSet: true },
		},
		rootShellOpenedAlert: file.rootShellOpenedAlert,
	};
}
