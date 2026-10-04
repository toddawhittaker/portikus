import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
	type Alert,
	type AlertChannels,
	anyAlertChannel,
	sendAlert,
	sendPushover,
	sendWebhook,
	webhookBody,
} from "./alerts.js";

interface Received {
	path: string;
	type: string;
	body: string;
}

let server: Server | undefined;

/** A local receiver that records each request and answers with `status`. */
async function fakeServer(status = 200): Promise<{ url: string; got: Received[] }> {
	const got: Received[] = [];
	server = createServer((req: IncomingMessage, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			got.push({
				path: req.url ?? "",
				type: req.headers["content-type"] ?? "",
				body,
			});
			res.statusCode = status;
			res.end("{}");
		});
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, got };
}

afterEach(async () => {
	await new Promise((r) => (server ? server.close(r) : r(undefined)));
	server = undefined;
});

const alert: Alert = {
	title: "A backup failed",
	text: "The Backups tab shows why.",
	tone: "danger",
	at: new Date("2026-10-04T12:00:00Z"),
};

const off: AlertChannels = {
	pushoverUserKey: "",
	pushoverAppToken: "",
	webhookUrl: "",
};

describe("webhook body", () => {
	test("is exactly text, title, tone, site and at", () => {
		expect(webhookBody(alert, "portikus-pilot")).toEqual({
			text: "A backup failed\nThe Backups tab shows why.",
			title: "A backup failed",
			tone: "danger",
			site: "portikus-pilot",
			at: "2026-10-04T12:00:00.000Z",
		});
	});
});

describe("senders", () => {
	test("the webhook posts the JSON body", async () => {
		const fake = await fakeServer();
		const result = await sendWebhook(`${fake.url}/hook/secret`, alert, "site-a");
		expect(result).toEqual({ channel: "webhook", ok: true });
		expect(fake.got).toHaveLength(1);
		expect(fake.got[0]?.path).toBe("/hook/secret");
		expect(fake.got[0]?.type).toBe("application/json");
		expect(JSON.parse(fake.got[0]?.body ?? "")).toEqual(webhookBody(alert, "site-a"));
	});

	test("pushover posts the token, user key and message as a form", async () => {
		const fake = await fakeServer();
		const channels = { ...off, pushoverUserKey: "ukey", pushoverAppToken: "atok" };
		const result = await sendPushover(
			channels,
			alert,
			"site-a",
			`${fake.url}/1/messages.json`,
		);
		expect(result).toEqual({ channel: "pushover", ok: true });
		const form = new URLSearchParams(fake.got[0]?.body);
		expect(fake.got[0]?.type).toContain("application/x-www-form-urlencoded");
		expect(form.get("token")).toBe("atok");
		expect(form.get("user")).toBe("ukey");
		expect(form.get("title")).toBe("A backup failed");
		expect(form.get("message")).toContain("The Backups tab shows why.");
		expect(form.get("priority")).toBe("1");
	});

	test("a refused or unreachable send reports an error without the URL", async () => {
		const fake = await fakeServer(500);
		const refused = await sendWebhook(`${fake.url}/hook/secret`, alert, "s");
		expect(refused).toEqual({ channel: "webhook", ok: false, error: "HTTP 500" });
		const gone = await sendWebhook("http://127.0.0.1:1/hook/secret", alert, "s");
		expect(gone).toEqual({ channel: "webhook", ok: false, error: "unreachable" });
	});

	test("sendAlert tries only configured channels", async () => {
		expect(anyAlertChannel(off)).toBe(false);
		expect(await sendAlert(off, alert, "s")).toEqual([]);
		// A user key without an app token is not a channel.
		expect(await sendAlert({ ...off, pushoverUserKey: "u" }, alert, "s")).toEqual([]);
		const fake = await fakeServer();
		const both = {
			pushoverUserKey: "u",
			pushoverAppToken: "t",
			webhookUrl: `${fake.url}/hook`,
		};
		const results = await sendAlert(both, alert, "s", `${fake.url}/push`);
		expect(results.map((r) => r.channel)).toEqual(["pushover", "webhook"]);
		expect(fake.got.map((g) => g.path)).toEqual(["/push", "/hook"]);
	});
});
