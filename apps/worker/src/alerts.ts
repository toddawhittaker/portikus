import { adminAlertGroups, type Database } from "@portikus/db";
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

/** How long an alert waits for the API's explanation before it is sent without one. */
export const TRIAGE_WAIT_MS = 60_000;
const TRIAGE_POLL_MS = 5_000;
// The rows of one alert are written together; an older alert with the same words is a different one.
const ALERT_ROWS_SPREAD_MS = 60_000;

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

type Send = (alert: Alert, channels: AlertChannels) => Promise<ChannelResult[]>;

export interface AlertForwarderOptions {
	db: Kysely<Database>;
	logger: Logger;
	/** The channels as they are now; read at each tick, so a settings change needs no restart (ADR 0052). */
	loadChannels: () => Promise<AlertChannels>;
	now?: () => Date;
	send?: Send;
	/** Waits between looks for an explanation; tests advance a fake clock. */
	sleep?: (ms: number) => Promise<void>;
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
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const gate = new AlertGate();
	let since = now();

	/** The stored explanation, waiting up to TRIAGE_WAIT_MS from when the alert was raised. */
	async function awaitTriage(row: AlertRow, at: Date): Promise<string | null> {
		const deadline = at.getTime() + TRIAGE_WAIT_MS;
		for (;;) {
			const found = await triageOf(db, row, at);
			if (found !== null) return found;
			const left = deadline - now().getTime();
			if (left <= 0) return null;
			await sleep(Math.min(TRIAGE_POLL_MS, left));
		}
	}

	return async function tick(): Promise<void> {
		let channels: AlertChannels;
		try {
			channels = await loadChannels();
		} catch (e) {
			// The message names only the file, never its contents.
			logger.warn({ error: errorMessage(e) }, "alert settings could not be read");
			// `since` stays put, so these alerts go out once the file reads again.
			return;
		}
		const rows = await adminAlertsSince(db, since);
		// Rows read while no channel is set are passed over, never sent later.
		const live = anyAlertChannel(channels) ? channels : null;
		const explain =
			live !== null &&
			rows.length > 0 &&
			explanationChannels(live) !== null &&
			(await forwardsTriage(db, logger));
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
			const triage = explain ? await awaitTriage(row, at) : null;
			await forward(send, alert, live, logger, triage);
		}
	};
}

type AlertRow = Awaited<ReturnType<typeof adminAlertsSince>>[number];

/**
 * Whether administrators asked for explanations on email and Pushover
 * (SPEC.md section 20.4). The worker reads only these two switches and the
 * stored text; the API writes it, and the worker never calls a model.
 */
async function forwardsTriage(db: Kysely<Database>, logger: Logger): Promise<boolean> {
	try {
		const row = await db
			.selectFrom("ai_settings")
			.select(["triage_enabled", "triage_forward"])
			.executeTakeFirst();
		return row?.triage_enabled === true && row.triage_forward === true;
	} catch (e) {
		logger.warn(
			{ error: errorMessage(e) },
			"alert explanation switch could not be read",
		);
		return false;
	}
}

async function triageOf(
	db: Kysely<Database>,
	row: AlertRow,
	at: Date,
): Promise<string | null> {
	const found = await db
		.selectFrom("notifications")
		.select("triage")
		.where("site_alert", "=", true)
		.where("title", "=", row.title)
		.where("body", "=", row.body)
		.where("tone", "=", row.tone)
		.where("triage", "is not", null)
		.where("created_at", ">", new Date(at.getTime() - ALERT_ROWS_SPREAD_MS))
		.limit(1)
		.executeTakeFirst();
	return found?.triage ?? null;
}

/** Only email and Pushover carry the explanation; null when neither is set. */
function explanationChannels(channels: AlertChannels): AlertChannels | null {
	const picked: AlertChannels = {
		pushoverUserKey: channels.pushoverUserKey,
		pushoverAppToken: channels.pushoverAppToken,
		webhookUrl: "",
		email: channels.email ?? null,
		ntfy: null,
		teamsUrl: "",
		...(channels.proxyUrl !== undefined ? { proxyUrl: channels.proxyUrl } : {}),
	};
	return anyAlertChannel(picked) ? picked : null;
}

/** The other channels, which are sent the alert as it is. */
function plainChannels(channels: AlertChannels): AlertChannels {
	return { ...channels, pushoverUserKey: "", pushoverAppToken: "", email: null };
}

/**
 * Warning and danger site alerts for administrators created after `since`,
 * one row per distinct alert, oldest first.
 */
function adminAlertsSince(db: Kysely<Database>, since: Date) {
	return (
		adminAlertGroups(db)
			// At the Date's precision, or the newest row stays newer than `since`.
			.where(
				sql<Date>`date_trunc('milliseconds', notifications.created_at)`,
				">",
				since,
			)
			.orderBy("at")
			.execute()
	);
}

/**
 * Send one alert and log each channel's outcome; a failed send is logged,
 * never thrown. With an explanation, email and Pushover get it appended.
 */
async function forward(
	send: Send,
	alert: Alert,
	channels: AlertChannels,
	logger: Logger,
	triage: string | null,
): Promise<void> {
	const explained = triage === null ? null : explanationChannels(channels);
	const sends: [Alert, AlertChannels][] =
		explained === null
			? [[alert, channels]]
			: [
					[{ ...alert, text: `${alert.text}\n\nAI explanation: ${triage}` }, explained],
					[alert, plainChannels(channels)],
				];
	for (const [message, to] of sends) {
		if (!anyAlertChannel(to)) continue;
		await sendOnce(send, message, to, logger);
	}
}

async function sendOnce(
	send: Send,
	alert: Alert,
	channels: AlertChannels,
	logger: Logger,
): Promise<void> {
	try {
		for (const result of await send(alert, channels)) {
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

/** Forward now and then every ALERT_FORWARD_SECONDS; returns a stop function. */
export function startAlertForwarding(options: AlertForwarderOptions): () => void {
	return startLoop(
		"alert forwarding",
		options.logger,
		createAlertForwarder(options),
		ALERT_FORWARD_SECONDS * 1000,
	);
}
