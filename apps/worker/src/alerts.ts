import type { Database } from "@portikus/db";
import {
	type Alert,
	type AlertChannels,
	anyAlertChannel,
	type ChannelResult,
	errorMessage,
	type Logger,
	sendAlert,
} from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { startLoop } from "./loop.js";

/**
 * Push new warning and danger admin notifications off the site (STACK.md
 * section 15). The notification row is the alert; this loop only forwards.
 */

/** How often the worker looks for new admin notifications. */
const ALERT_FORWARD_SECONDS = 30;

/** An alert repeating within this long of its last sighting is the same episode. */
export const ALERT_QUIET_MS = 60 * 60_000;

/** At most this many alerts leave the site in any rolling hour. */
export const ALERTS_PER_HOUR = 10;

const HOUR_MS = 60 * 60_000;

/**
 * Flood control. The title is the alert's key: a key fires once, then stays
 * quiet while it keeps recurring, and fires again only after an hour without
 * it. Above ALERTS_PER_HOUR in a rolling hour, the rest are dropped.
 */
export class AlertGate {
	private readonly lastSeen = new Map<string, number>();
	private sent: number[] = [];

	/** Record a sighting of `key` at `now`; true when it may be sent. */
	admit(key: string, now: Date): boolean {
		const t = now.getTime();
		const seen = this.lastSeen.get(key);
		this.lastSeen.set(key, t);
		for (const [k, at] of this.lastSeen)
			if (t - at > ALERT_QUIET_MS) this.lastSeen.delete(k);
		if (seen !== undefined && t - seen <= ALERT_QUIET_MS) return false;
		this.sent = this.sent.filter((at) => t - at < HOUR_MS);
		if (this.sent.length >= ALERTS_PER_HOUR) return false;
		this.sent.push(t);
		return true;
	}
}

export interface AlertForwarderOptions {
	db: Kysely<Database>;
	logger: Logger;
	/** The channels as they are now; read at each tick, so a settings change needs no restart (ADR 0052). */
	loadChannels: () => Promise<AlertChannels>;
	now?: () => Date;
	send?: (alert: Alert, channels: AlertChannels) => Promise<ChannelResult[]>;
}

/**
 * Build the tick that forwards admin notifications created since the last
 * tick. `notifyAdministrators` writes one row per administrator, so rows are
 * grouped and each alert is sent once. Notifications from before the worker
 * started are not sent; a restart may skip, never repeat, an old alert.
 */
export function createAlertForwarder(
	options: AlertForwarderOptions,
): () => Promise<void> {
	const { db, logger, loadChannels } = options;
	const now = options.now ?? (() => new Date());
	const send =
		options.send ??
		((alert: Alert, channels: AlertChannels) => sendAlert(channels, alert));
	const gate = new AlertGate();
	let since = now();

	return async function tick(): Promise<void> {
		let channels: AlertChannels | null = null;
		try {
			channels = await loadChannels();
		} catch (e) {
			// The message names only the file, never its contents.
			logger.warn({ error: errorMessage(e) }, "alert settings could not be read");
			// `since` stays put, so these alerts go out once the file reads again.
			return;
		}
		const rows = await db
			.selectFrom("notifications")
			.innerJoin("users", "users.id", "notifications.user_id")
			.select(["notifications.title", "notifications.body", "notifications.tone"])
			.select((eb) => eb.fn.max("notifications.created_at").as("at"))
			.where("users.role", "=", "administrator")
			// Personal notices to an administrator stay on the site.
			.where("notifications.site_alert", "=", true)
			.where("notifications.tone", "in", ["warning", "danger"])
			// At the Date's precision, or the newest row stays newer than `since`.
			.where(
				sql<Date>`date_trunc('milliseconds', notifications.created_at)`,
				">",
				since,
			)
			.groupBy(["notifications.title", "notifications.body", "notifications.tone"])
			.orderBy("at")
			.execute();
		// Rows read while no channel is set are passed over, never sent later.
		const live = channels && anyAlertChannel(channels) ? channels : null;
		for (const row of rows) {
			const at = new Date(row.at);
			if (at > since) since = at;
			if (!live) continue;
			if (!gate.admit(row.title, now())) {
				logger.info({ title: row.title }, "alert held back by flood control");
				continue;
			}
			const alert: Alert = {
				title: row.title,
				text: row.body,
				tone: row.tone === "danger" ? "danger" : "warning",
				at,
			};
			try {
				for (const result of await send(alert, live)) {
					if (result.ok) logger.info({ channel: result.channel }, "alert sent");
					else
						logger.warn(
							{ channel: result.channel, error: result.error },
							"alert could not be sent",
						);
				}
			} catch (e) {
				logger.warn({ error: errorMessage(e) }, "alert could not be sent");
			}
		}
	};
}

/** Forward now and then every ALERT_FORWARD_SECONDS; returns a stop function. */
export function startAlertForwarding(options: AlertForwarderOptions): () => void {
	return startLoop(
		"alert forwarding",
		options.logger,
		createAlertForwarder(options),
		ALERT_FORWARD_SECONDS * 1000,
	);
}
