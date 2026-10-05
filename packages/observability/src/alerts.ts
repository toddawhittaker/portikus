import { hostname } from "node:os";
import { createOutboundFetch, type OutboundFetch } from "./outbound-fetch.js";

/**
 * Administrator alerts pushed off the site (STACK.md section 15). An alert is
 * an admin notification with tone warning or danger; each channel is one
 * plain function, and `sendAlert` tries every configured one.
 */

export type AlertTone = "warning" | "danger";

export interface Alert {
	title: string;
	text: string;
	tone: AlertTone;
	at: Date;
}

/** Empty strings mean the channel is off, as in the environment. */
export interface AlertChannels {
	pushoverUserKey: string;
	pushoverAppToken: string;
	webhookUrl: string;
	/** The egress proxy every send goes through; unset sends directly, for development. */
	proxyUrl?: string;
}

/**
 * The JSON body every webhook receives; a contract with whatever listens.
 * `text` alone is what Slack's incoming webhooks read.
 */
export interface AlertWebhookBody {
	text: string;
	title: string;
	tone: AlertTone;
	site: string;
	at: string;
}

export interface ChannelResult {
	channel: "pushover" | "webhook";
	ok: boolean;
	/** Never holds a key, token or URL. */
	error?: string;
}

export const PUSHOVER_MESSAGES_URL = "https://api.pushover.net/1/messages.json";

const SEND_TIMEOUT_MS = 10_000;

/** The channel settings from a parsed service config. */
export function alertChannelsFromConfig(config: {
	ALERT_PUSHOVER_USER_KEY: string;
	ALERT_PUSHOVER_APP_TOKEN: string;
	ALERT_WEBHOOK_URL: string;
	OUTBOUND_PROXY_URL?: string;
}): AlertChannels {
	return {
		pushoverUserKey: config.ALERT_PUSHOVER_USER_KEY,
		pushoverAppToken: config.ALERT_PUSHOVER_APP_TOKEN,
		webhookUrl: config.ALERT_WEBHOOK_URL,
		proxyUrl: config.OUTBOUND_PROXY_URL,
	};
}

export function pushoverConfigured(channels: AlertChannels): boolean {
	return channels.pushoverUserKey !== "" && channels.pushoverAppToken !== "";
}

export function anyAlertChannel(channels: AlertChannels): boolean {
	return pushoverConfigured(channels) || channels.webhookUrl !== "";
}

/** Which site sent the alert; the host name is what an operator recognises. */
export function alertSite(): string {
	return hostname();
}

export function webhookBody(alert: Alert, site: string): AlertWebhookBody {
	return {
		text: `${alert.title}\n${alert.text}`,
		title: alert.title,
		tone: alert.tone,
		site,
		at: alert.at.toISOString(),
	};
}

/** Turn a failed fetch into a message that cannot carry the URL or a secret. */
async function post(
	send: OutboundFetch,
	url: string,
	init: RequestInit,
): Promise<string | null> {
	try {
		const res = await send(url, {
			...init,
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		// Read, not cancelled: cancelling the proxied body leaves Node's stream
		// adapter enqueueing into a closed stream, an uncaught exception.
		await res.arrayBuffer();
		return res.ok ? null : `HTTP ${res.status}`;
	} catch (e) {
		return e instanceof Error && e.name === "TimeoutError"
			? "timed out"
			: "unreachable";
	}
}

export async function sendPushover(
	channels: AlertChannels,
	alert: Alert,
	site: string,
	url: string = PUSHOVER_MESSAGES_URL,
): Promise<ChannelResult> {
	const form = new URLSearchParams({
		token: channels.pushoverAppToken,
		user: channels.pushoverUserKey,
		title: alert.title,
		message: `${alert.text}\n(${site})`,
		// High priority skips the recipient's quiet hours.
		priority: alert.tone === "danger" ? "1" : "0",
		timestamp: String(Math.floor(alert.at.getTime() / 1000)),
	});
	// The proxied fetch sends the body as a string, so the type is set here.
	const error = await post(createOutboundFetch(channels.proxyUrl), url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
	return error
		? { channel: "pushover", ok: false, error }
		: { channel: "pushover", ok: true };
}

export async function sendWebhook(
	channels: AlertChannels,
	alert: Alert,
	site: string,
): Promise<ChannelResult> {
	const error = await post(
		createOutboundFetch(channels.proxyUrl),
		channels.webhookUrl,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(webhookBody(alert, site)),
		},
	);
	return error
		? { channel: "webhook", ok: false, error }
		: { channel: "webhook", ok: true };
}

/** Send to every configured channel; an empty result means none is set. */
export async function sendAlert(
	channels: AlertChannels,
	alert: Alert,
	site: string = alertSite(),
	pushoverUrl: string = PUSHOVER_MESSAGES_URL,
): Promise<ChannelResult[]> {
	const results: ChannelResult[] = [];
	if (pushoverConfigured(channels))
		results.push(await sendPushover(channels, alert, site, pushoverUrl));
	if (channels.webhookUrl !== "")
		results.push(await sendWebhook(channels, alert, site));
	return results;
}
