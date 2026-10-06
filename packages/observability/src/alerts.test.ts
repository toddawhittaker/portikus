import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
} from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_FILE_OFF, type NotifyFile, type NotifySmtp } from "@portikus/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
	type Alert,
	type AlertChannels,
	alertChannelsFromNotifyFile,
	anyAlertChannel,
	type MailTransportFactory,
	readAlertChannels,
	readNotifyFile,
	sendAlert,
	sendEmail,
	sendNtfy,
	sendPushover,
	sendTeams,
	sendWebhook,
	teamsBody,
	webhookBody,
} from "./alerts.js";
import { collectingLogger } from "./testing.js";

interface Received {
	path: string;
	type: string;
	body: string;
	headers: IncomingHttpHeaders;
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
				headers: req.headers,
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
		const result = await sendWebhook(
			{ ...off, webhookUrl: `${fake.url}/hook/secret` },
			alert,
			"site-a",
		);
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
		const refused = await sendWebhook(
			{ ...off, webhookUrl: `${fake.url}/hook/secret` },
			alert,
			"s",
		);
		expect(refused).toEqual({ channel: "webhook", ok: false, error: "HTTP 500" });
		const gone = await sendWebhook(
			{ ...off, webhookUrl: "http://127.0.0.1:1/hook/secret" },
			alert,
			"s",
		);
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

	// The API and worker units reach nothing outside but the egress proxy (ADR 0027).
	test("with a proxy URL both channels go through the proxy", async () => {
		const proxy = await fakeServer();
		const channels: AlertChannels = {
			pushoverUserKey: "u",
			pushoverAppToken: "t",
			webhookUrl: "http://hooks.example.invalid/services/T0",
			proxyUrl: proxy.url,
		};
		const results = await sendAlert(
			channels,
			alert,
			"s",
			"http://api.pushover.example.invalid/1/messages.json",
		);
		expect(results).toEqual([
			{ channel: "pushover", ok: true },
			{ channel: "webhook", ok: true },
		]);
		expect(proxy.got.map((g) => g.path)).toEqual([
			"http://api.pushover.example.invalid/1/messages.json",
			"http://hooks.example.invalid/services/T0",
		]);
		expect(proxy.got[0]?.type).toBe("application/x-www-form-urlencoded");
		expect(new URLSearchParams(proxy.got[0]?.body).get("token")).toBe("t");
		expect(JSON.parse(proxy.got[1]?.body ?? "")).toEqual(webhookBody(alert, "s"));
	});
});

const SMTP_PASSWORD = "smtp-pass-s3cret";

const smtp: NotifySmtp = {
	host: "smtp.example.edu",
	port: 587,
	username: "portikus",
	password: SMTP_PASSWORD,
	from: "Portikus <portikus@example.edu>",
};

/** A transport factory that records its options and the message, then runs `send`. */
function fakeTransport(send: () => Promise<unknown> = async () => ({})) {
	const seen = {
		options: [] as Record<string, unknown>[],
		mail: [] as Record<string, unknown>[],
		closed: 0,
	};
	const factory = ((options: Record<string, unknown>) => {
		seen.options.push(options);
		return {
			sendMail: async (mail: Record<string, unknown>) => {
				seen.mail.push(mail);
				return send();
			},
			close: () => {
				seen.closed++;
			},
		};
	}) as unknown as MailTransportFactory;
	return { factory, seen };
}

/** A failure whose message quotes the password, as a careless server reply might. */
function failure(code: string): () => Promise<never> {
	return async () => {
		const e = new Error(`535 password ${SMTP_PASSWORD} rejected`) as Error & {
			code: string;
		};
		e.code = code;
		throw e;
	};
}

describe("email", () => {
	const channels: AlertChannels = { ...off, email: { smtp, to: ["ops@example.edu"] } };

	test("port 587 requires STARTTLS and verifies the certificate", async () => {
		const { factory, seen } = fakeTransport();
		const result = await sendEmail(channels, alert, "site-a", factory);
		expect(result).toEqual({ channel: "email", ok: true });
		expect(seen.options[0]).toMatchObject({
			host: "smtp.example.edu",
			port: 587,
			secure: false,
			requireTLS: true,
			// Its debug output prints the base64 AUTH exchange.
			logger: false,
			debug: false,
			tls: { rejectUnauthorized: true },
			auth: { user: "portikus", pass: SMTP_PASSWORD },
		});
		expect(seen.mail[0]).toMatchObject({
			from: smtp.from,
			to: ["ops@example.edu"],
			subject: "A backup failed",
		});
		expect(String(seen.mail[0]?.text)).toContain("site-a");
		expect(seen.closed).toBe(1);
	});

	test("port 465 starts in TLS", async () => {
		const { factory, seen } = fakeTransport();
		await sendEmail(
			{ ...off, email: { smtp: { ...smtp, port: 465 }, to: ["a@example.edu"] } },
			alert,
			"s",
			factory,
		);
		expect(seen.options[0]).toMatchObject({
			port: 465,
			secure: true,
			requireTLS: true,
		});
	});

	test("an empty user name sends without signing in", async () => {
		const { factory, seen } = fakeTransport();
		await sendEmail(
			{
				...off,
				email: { smtp: { ...smtp, username: "", password: "" }, to: ["a@example.edu"] },
			},
			alert,
			"s",
			factory,
		);
		expect(seen.options[0]?.auth).toBeUndefined();
	});

	test("mail leaves through the egress proxy", async () => {
		const { factory, seen } = fakeTransport();
		await sendEmail(
			{ ...channels, proxyUrl: "http://127.0.0.1:3128" },
			alert,
			"s",
			factory,
		);
		expect(seen.options[0]?.proxy).toBe("http://127.0.0.1:3128");
	});

	test.each([
		["EAUTH", "authentication failed"],
		["ETLS", "TLS failed"],
		["EREQUIRETLS", "TLS failed"],
		["ETIMEDOUT", "timed out"],
		["EENVELOPE", "rejected"],
		["ECONNECTION", "unreachable"],
	])("a %s failure reports %s and never the server's text", async (code, error) => {
		const { factory, seen } = fakeTransport(failure(code));
		const result = await sendEmail(channels, alert, "s", factory);
		expect(result).toEqual({ channel: "email", ok: false, error });
		expect(JSON.stringify(result)).not.toContain(SMTP_PASSWORD);
		expect(seen.closed).toBe(1);
	});

	test("without settings it reports not configured", async () => {
		expect(await sendEmail(off, alert, "s")).toEqual({
			channel: "email",
			ok: false,
			error: "not configured",
		});
	});

	// A server that never offers STARTTLS must not receive the password in clear.
	test("a server without STARTTLS is refused before signing in", async () => {
		const lines: string[] = [];
		const tcp = createTcpServer((socket) => {
			socket.write("220 fake ESMTP\r\n");
			socket.on("data", (chunk) => {
				for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
					lines.push(line);
					if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
					else if (/^STARTTLS/i.test(line)) socket.write("502 not supported\r\n");
					else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
					else socket.write("250 ok\r\n");
				}
			});
		});
		await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
		const { port } = tcp.address() as AddressInfo;
		try {
			// The schema allows only 587 and 465; the test server takes any free port.
			const local = { ...smtp, host: "127.0.0.1", port: port as 587 };
			const result = await sendEmail(
				{ ...off, email: { smtp: local, to: ["a@example.edu"] } },
				alert,
				"s",
			);
			expect(result).toEqual({ channel: "email", ok: false, error: "TLS failed" });
			expect(lines.some((l) => /^AUTH/i.test(l))).toBe(false);
		} finally {
			await new Promise((r) => tcp.close(r));
		}
	});
});

describe("ntfy", () => {
	test("posts the text with Title, Priority and Tags headers and the token", async () => {
		const fake = await fakeServer();
		const result = await sendNtfy(
			{ ...off, ntfy: { url: `${fake.url}/portikus-alerts`, token: "tk_abc" } },
			alert,
			"site-a",
		);
		expect(result).toEqual({ channel: "ntfy", ok: true });
		const got = fake.got[0];
		expect(got?.path).toBe("/portikus-alerts");
		expect(got?.type).toContain("text/plain");
		expect(got?.body).toBe("The Backups tab shows why.\n(site-a)");
		expect(got?.headers.priority).toBe("5");
		expect(got?.headers.tags).toBe("rotating_light");
		expect(got?.headers.authorization).toBe("Bearer tk_abc");
		const title = String(got?.headers.title).match(/^=\?UTF-8\?B\?(.*)\?=$/)?.[1] ?? "";
		expect(Buffer.from(title, "base64").toString()).toBe("A backup failed");
	});

	test("a warning is priority 4 and no token sends no Authorization", async () => {
		const fake = await fakeServer();
		await sendNtfy(
			{ ...off, ntfy: { url: `${fake.url}/t`, token: "" } },
			{ ...alert, tone: "warning" },
			"s",
		);
		expect(fake.got[0]?.headers.priority).toBe("4");
		expect(fake.got[0]?.headers.authorization).toBeUndefined();
	});

	test("a failure names the status, never the topic or token", async () => {
		const fake = await fakeServer(403);
		const result = await sendNtfy(
			{ ...off, ntfy: { url: `${fake.url}/secret-topic`, token: "tk_secret" } },
			alert,
			"s",
		);
		expect(result).toEqual({ channel: "ntfy", ok: false, error: "HTTP 403" });
	});
});

describe("Teams", () => {
	test("posts one Adaptive Card", async () => {
		const fake = await fakeServer(202);
		const result = await sendTeams(
			{ ...off, teamsUrl: `${fake.url}/workflows/secret-sig` },
			alert,
			"site-a",
		);
		expect(result).toEqual({ channel: "teams", ok: true });
		const body = JSON.parse(fake.got[0]?.body ?? "");
		expect(body).toEqual(teamsBody(alert, "site-a"));
		expect(body.type).toBe("message");
		const card = body.attachments[0];
		expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
		expect(card.content.type).toBe("AdaptiveCard");
		const texts = card.content.body.map((b: { text: string }) => b.text);
		expect(texts).toContain("A backup failed");
		expect(texts).toContain("The Backups tab shows why.");
	});

	test("a failure never carries the URL", async () => {
		const result = await sendTeams(
			{ ...off, teamsUrl: "http://127.0.0.1:1/workflows/secret-sig" },
			alert,
			"s",
		);
		expect(result).toEqual({ channel: "teams", ok: false, error: "unreachable" });
	});

	test("without a URL it reports not configured", async () => {
		expect((await sendTeams(off, alert, "s")).error).toBe("not configured");
		expect((await sendNtfy(off, alert, "s")).error).toBe("not configured");
	});
});

describe("sendAlert with every channel", () => {
	test("tries each configured channel once, in a fixed order", async () => {
		const fake = await fakeServer();
		const { factory, seen } = fakeTransport();
		const channels: AlertChannels = {
			pushoverUserKey: "u",
			pushoverAppToken: "t",
			webhookUrl: `${fake.url}/hook`,
			email: { smtp, to: ["a@example.edu"] },
			ntfy: { url: `${fake.url}/ntfy`, token: "" },
			teamsUrl: `${fake.url}/teams`,
		};
		expect(anyAlertChannel(channels)).toBe(true);
		const results = await sendAlert(channels, alert, "s", `${fake.url}/push`, factory);
		expect(results.map((r) => r.channel)).toEqual([
			"pushover",
			"webhook",
			"email",
			"ntfy",
			"teams",
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(fake.got.map((g) => g.path)).toEqual(["/push", "/hook", "/ntfy", "/teams"]);
		expect(seen.mail).toHaveLength(1);
	});

	test("each new channel alone counts as a channel", () => {
		expect(anyAlertChannel({ ...off, email: { smtp, to: ["a@example.edu"] } })).toBe(
			true,
		);
		expect(
			anyAlertChannel({ ...off, ntfy: { url: "https://ntfy.sh/t", token: "" } }),
		).toBe(true);
		expect(anyAlertChannel({ ...off, teamsUrl: "https://x.example/w" })).toBe(true);
	});
});

describe("the settings file", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
		dir = "";
	});

	async function write(content: string): Promise<string> {
		dir = await mkdtemp(join(tmpdir(), "notify-"));
		const path = join(dir, "notify.json");
		await writeFile(path, content);
		return path;
	}

	const full: NotifyFile = {
		version: 1,
		smtp,
		alerts: {
			email: { to: ["ops@example.edu"] },
			pushover: { userKey: "ukey", appToken: "atok" },
			webhook: { url: "https://hooks.example.com/services/T0" },
			ntfy: { url: "https://ntfy.sh/portikus", token: "tk" },
			teams: { url: "https://teams.example.com/workflows/x" },
		},
		rootShellOpenedAlert: true,
	};

	test("a missing file reads as everything off", async () => {
		const file = await readNotifyFile("/nonexistent/portikus/notify.json");
		expect(file).toEqual(NOTIFY_FILE_OFF);
		expect(file.rootShellOpenedAlert).toBe(false);
		expect(anyAlertChannel(alertChannelsFromNotifyFile(file))).toBe(false);
	});

	test("a full file reads back and maps onto the channels", async () => {
		const file = await readNotifyFile(await write(JSON.stringify(full)));
		expect(file).toEqual(full);
		expect(alertChannelsFromNotifyFile(file, "http://127.0.0.1:3128")).toEqual({
			pushoverUserKey: "ukey",
			pushoverAppToken: "atok",
			webhookUrl: "https://hooks.example.com/services/T0",
			email: { smtp, to: ["ops@example.edu"] },
			ntfy: { url: "https://ntfy.sh/portikus", token: "tk" },
			teamsUrl: "https://teams.example.com/workflows/x",
			proxyUrl: "http://127.0.0.1:3128",
		});
	});

	test("readAlertChannels reads the file at each call, with the proxy", async () => {
		const path = await write(JSON.stringify(NOTIFY_FILE_OFF));
		expect(anyAlertChannel(await readAlertChannels(path))).toBe(false);
		await writeFile(path, JSON.stringify(full));
		const channels = await readAlertChannels(path, "http://127.0.0.1:3128");
		expect(channels.webhookUrl).toBe("https://hooks.example.com/services/T0");
		expect(channels.proxyUrl).toBe("http://127.0.0.1:3128");
	});

	test("a missing rootShellOpenedAlert reads as false", async () => {
		const { rootShellOpenedAlert: _, ...rest } = full;
		const file = await readNotifyFile(await write(JSON.stringify(rest)));
		expect(file.rootShellOpenedAlert).toBe(false);
	});

	test("a malformed file throws without quoting its secrets", async () => {
		const badPort = JSON.stringify({ ...full, smtp: { ...smtp, port: 25 } });
		const badPassword = JSON.stringify({ ...full, smtp: { ...smtp, password: 7 } });
		const notJson = `{"smtp": {"password": "${SMTP_PASSWORD}"`;
		for (const content of [badPort, badPassword, notJson]) {
			const path = await write(content);
			const error = await readNotifyFile(path).then(
				() => null,
				(e: Error) => e,
			);
			expect(error).toBeInstanceOf(Error);
			expect(error?.message).toContain(path);
			expect(error?.message).not.toContain(SMTP_PASSWORD);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable path throws only its name", async () => {
		dir = await mkdtemp(join(tmpdir(), "notify-"));
		await expect(readNotifyFile(dir)).rejects.toThrow(`cannot read ${dir}`);
	});
});

describe("logging", () => {
	// STACK.md section 15: a careless log of the settings must not leak a credential.
	test("the channel settings and the file log with every secret redacted", () => {
		const { logger, lines } = collectingLogger();
		const channels: AlertChannels = {
			pushoverUserKey: "ukeysecret",
			pushoverAppToken: "atoksecret",
			webhookUrl: "https://hooks.example.com/hook-secret",
			email: { smtp, to: ["a@example.edu"] },
			ntfy: { url: "https://ntfy.sh/topic-secret", token: "tk-secret" },
			teamsUrl: "https://teams.example.com/w?sig=teams-secret",
		};
		const file: NotifyFile = {
			version: 1,
			smtp,
			alerts: {
				email: null,
				pushover: { userKey: "ukeysecret", appToken: "atoksecret" },
				webhook: { url: "https://hooks.example.com/hook-secret" },
				ntfy: { url: "https://ntfy.sh/topic-secret", token: "tk-secret" },
				teams: { url: "https://teams.example.com/w?sig=teams-secret" },
			},
			rootShellOpenedAlert: false,
		};
		logger.info({ channels }, "channels");
		logger.info({ file }, "file");
		logger.info(file, "file at the top");
		const text = JSON.stringify(lines);
		for (const secret of [
			SMTP_PASSWORD,
			"ukeysecret",
			"atoksecret",
			"hook-secret",
			"topic-secret",
			"tk-secret",
			"teams-secret",
		]) {
			expect(text, secret).not.toContain(secret);
		}
	});
});
