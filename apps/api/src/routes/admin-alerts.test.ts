import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	AdminNotifications,
	NOTIFY_FILE_OFF,
	type NotificationSettingsUpdate,
	type NotifyFile,
	type NotifyJobRequestFile,
	NotifyJobView,
	TestAlertResponse,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { STALE_JOB_MS } from "../alerts/jobs.js";
import { TEST_ALERTS_PER_MINUTE } from "../rate-limit.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let proxy: Server;
let proxyUrl: string;
const tunnels: string[] = [];
let dir = "";
let notifyFile = "";
let jobsDir = "";

// Secrets the stored file holds; no response, audit row or notice may repeat one.
const SECRETS = {
	smtpPassword: "smtp-pass-s3cret",
	userKey: "pushoverUserKeyS3cret",
	appToken: "pushoverAppTokenS3cret",
	webhookPath: "webhook-path-s3cret",
	ntfyTopic: "ntfy-topic-s3cret",
	ntfyToken: "ntfy-token-s3cret",
	teamsPath: "teams-path-s3cret",
};

const stored: NotifyFile = {
	version: 1,
	smtp: {
		host: "smtp.example.edu",
		port: 587,
		username: "portikus",
		password: SECRETS.smtpPassword,
		from: "Portikus <portikus@example.edu>",
	},
	alerts: {
		email: { to: ["ops@example.edu"] },
		pushover: { userKey: SECRETS.userKey, appToken: SECRETS.appToken },
		webhook: { url: `https://hooks.example.com/services/${SECRETS.webhookPath}` },
		ntfy: { url: `https://ntfy.sh/${SECRETS.ntfyTopic}`, token: SECRETS.ntfyToken },
		teams: { url: `https://teams.example.com/workflows/${SECRETS.teamsPath}` },
	},
	rootShellOpenedAlert: false,
};

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	// A fake egress proxy: plain requests (the mock sign-in provider) pass
	// through; every tunnel is refused, as Squid does for a host it does not list.
	proxy = createServer((req, res) => {
		const upstream = httpRequest(
			req.url ?? "",
			{ method: req.method, headers: req.headers },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		req.pipe(upstream);
	});
	proxy.on("connect", (req, socket) => {
		tunnels.push(req.url ?? "");
		socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
	});
	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
	proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await new Promise((r) => proxy.close(r));
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	tunnels.length = 0;
	dir = await mkdtemp(join(tmpdir(), "admin-alerts-"));
	notifyFile = join(dir, "notify.json");
	jobsDir = join(dir, "alerts-jobs");
	await mkdir(jobsDir);
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function server(overrides: Record<string, unknown> = {}): FastifyInstance {
	return buildTestServer(testDb.db, mock.issuer, {
		NOTIFY_FILE: notifyFile,
		ALERTS_JOBS_DIR: jobsDir,
		OUTBOUND_PROXY_URL: proxyUrl,
		...overrides,
	});
}

async function as(app: FastifyInstance, who: string) {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	return (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
		app.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

/** Plays the root alerts job for one request: applies it the simple way and writes a status. */
async function playJob(state: "succeeded" | "refused" = "succeeded"): Promise<string> {
	const [name] = (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
	if (!name) throw new Error("no request file");
	const path = join(jobsDir, name);
	const request = JSON.parse(await readFile(path, "utf8")) as NotifyJobRequestFile;
	await rm(path);
	if (state === "succeeded") {
		const s = request.settings;
		const file: NotifyFile = {
			version: 1,
			smtp: s.smtp && { ...s.smtp, password: s.smtp.password ?? "" },
			alerts: {
				email: s.alerts.email,
				pushover: s.alerts.pushover && {
					userKey: s.alerts.pushover.userKey ?? "",
					appToken: s.alerts.pushover.appToken ?? "",
				},
				webhook: s.alerts.webhook?.url ? { url: s.alerts.webhook.url } : null,
				ntfy: s.alerts.ntfy?.url
					? { url: s.alerts.ntfy.url, token: s.alerts.ntfy.token ?? "" }
					: null,
				teams: s.alerts.teams?.url ? { url: s.alerts.teams.url } : null,
			},
			rootShellOpenedAlert: s.rootShellOpenedAlert,
		};
		await writeFile(notifyFile, JSON.stringify(file));
	}
	await mkdir(join(jobsDir, request.id));
	await writeFile(
		join(jobsDir, request.id, "status.json"),
		JSON.stringify({
			id: request.id,
			state,
			code: state === "refused" ? "missing_secret" : null,
			channels: state === "succeeded" ? ["webhook"] : [],
			hosts: state === "succeeded" ? ["hooks.example.org"] : [],
			requestedAt: request.requestedAt,
			requestedBy: request.requestedBy,
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		}),
	);
	return request.id;
}

const webhookOnly: NotificationSettingsUpdate = {
	smtp: null,
	alerts: {
		email: null,
		pushover: null,
		webhook: { url: "https://hooks.example.org/new-hook-s3cret" },
		ntfy: null,
		teams: null,
	},
	rootShellOpenedAlert: true,
};

function expectNoSecret(text: string): void {
	for (const secret of [...Object.values(SECRETS), "new-hook-s3cret"]) {
		expect(text).not.toContain(secret);
	}
}

describe.skipIf(skip)("admin alert and notification routes (ADR 0052)", () => {
	test("only an administrator may use them", async () => {
		const app = server();
		await app.ready();
		try {
			const origin = { origin: new URL(PUBLIC_URL).origin };
			for (const [method, url] of [
				["POST", "/admin/alerts/test"],
				["GET", "/admin/notifications"],
				["PUT", "/admin/notifications"],
			] as const) {
				expect((await app.inject({ method, url, headers: origin })).statusCode).toBe(
					401,
				);
				expect((await (await as(app, "alice"))(method, url, {})).statusCode).toBe(403);
			}
		} finally {
			await app.close();
		}
	});

	test("with no settings file the test sends nothing and the view is all off", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const res = await call("POST", "/admin/alerts/test");
			expect(res.statusCode).toBe(200);
			expect(TestAlertResponse.parse(res.json())).toEqual({ results: [] });
			const view = AdminNotifications.parse(
				(await call("GET", "/admin/notifications")).json(),
			);
			expect(view).toEqual({
				settings: {
					smtp: null,
					alerts: {
						email: null,
						pushover: null,
						webhook: null,
						ntfy: null,
						teams: null,
					},
					rootShellOpenedAlert: false,
				},
				job: null,
			});
		} finally {
			await app.close();
		}
	});

	test("the test reads the file now, through the proxy, for one channel or all", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			await writeFile(
				notifyFile,
				JSON.stringify({
					...NOTIFY_FILE_OFF,
					alerts: {
						...NOTIFY_FILE_OFF.alerts,
						webhook: stored.alerts.webhook,
						teams: stored.alerts.teams,
					},
				}),
			);
			const one = await call("POST", "/admin/alerts/test", { channel: "teams" });
			expect(one.json()).toEqual({
				results: [{ channel: "teams", ok: false, error: "unreachable" }],
			});
			expect(tunnels).toEqual(["teams.example.com:443"]);
			const all = await call("POST", "/admin/alerts/test", {});
			expect(all.json().results.map((r: { channel: string }) => r.channel)).toEqual([
				"webhook",
				"teams",
			]);
			expectNoSecret(one.body + all.body);
			const none = await call("POST", "/admin/alerts/test", { channel: "pushover" });
			expect(none.json()).toEqual({ results: [] });
			expect(
				(await call("POST", "/admin/alerts/test", { channel: "sms" })).statusCode,
			).toBe(400);
			// A test alert is not a notification, so the worker never forwards it again.
			expect(
				await testDb.db.selectFrom("notifications").select("id").execute(),
			).toEqual([]);
		} finally {
			await app.close();
		}
	});

	test("the view never returns a secret, only whether one is set", async () => {
		await writeFile(notifyFile, JSON.stringify(stored));
		const app = server();
		await app.ready();
		try {
			const res = await (await as(app, "carol"))("GET", "/admin/notifications");
			expect(res.statusCode).toBe(200);
			expect(res.headers["cache-control"]).toBe("no-store");
			expectNoSecret(res.body);
			expect(AdminNotifications.parse(res.json()).settings).toEqual({
				smtp: {
					host: "smtp.example.edu",
					port: 587,
					username: "portikus",
					passwordSet: true,
					from: "Portikus <portikus@example.edu>",
				},
				alerts: {
					email: { to: ["ops@example.edu"] },
					pushover: { userKeySet: true, appTokenSet: true },
					webhook: { host: "hooks.example.com", urlSet: true },
					ntfy: { host: "ntfy.sh", urlSet: true, tokenSet: true },
					teams: { host: "teams.example.com", urlSet: true },
				},
				rootShellOpenedAlert: false,
			});
		} finally {
			await app.close();
		}
	});

	test("an unreadable settings file is a 500 that names nothing inside it", async () => {
		await writeFile(notifyFile, `{"version": 1, "smtp": "${SECRETS.smtpPassword}"}`);
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			for (const res of [
				await call("GET", "/admin/notifications"),
				await call("POST", "/admin/alerts/test"),
				await call("PUT", "/admin/notifications", webhookOnly),
			]) {
				expect(res.statusCode).toBe(500);
				expectNoSecret(res.body);
			}
			expect(await readdir(jobsDir)).toEqual([]);
		} finally {
			await app.close();
		}
	});

	test("with no job directory the settings routes are 404", async () => {
		const app = server({ ALERTS_JOBS_DIR: undefined });
		await app.ready();
		try {
			const call = await as(app, "carol");
			expect((await call("GET", "/admin/notifications")).statusCode).toBe(404);
			expect((await call("PUT", "/admin/notifications", webhookOnly)).statusCode).toBe(
				404,
			);
		} finally {
			await app.close();
		}
	});

	test("a save round trip: request file, job status, new settings, one audit row and a notice", async () => {
		await writeFile(notifyFile, JSON.stringify(stored));
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const put = await call("PUT", "/admin/notifications", webhookOnly);
			expect(put.statusCode).toBe(202);
			const queued = NotifyJobView.parse(put.json());
			expect(queued.state).toBe("queued");
			expectNoSecret(put.body);

			const [name] = await readdir(jobsDir);
			expect(name).toBe(`request-${queued.id}.json`);
			const path = join(jobsDir, name ?? "");
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			const request = JSON.parse(await readFile(path, "utf8")) as NotifyJobRequestFile;
			expect(request.settings).toEqual(webhookOnly);
			expect(request.id).toBe(queued.id);

			const waiting = AdminNotifications.parse(
				(await call("GET", "/admin/notifications")).json(),
			);
			expect(waiting.job).toMatchObject({ id: queued.id, state: "queued" });
			expect(
				(await call("PUT", "/admin/notifications", webhookOnly)).json(),
			).toMatchObject({
				code: "NOTIFY_JOB_BUSY",
			});

			await playJob();
			const done = AdminNotifications.parse(
				(await call("GET", "/admin/notifications")).json(),
			);
			expect(done.job).toMatchObject({
				id: queued.id,
				state: "succeeded",
				code: null,
				hosts: ["hooks.example.org"],
			});
			expect(done.settings.alerts.webhook).toEqual({
				host: "hooks.example.org",
				urlSet: true,
			});
			expect(done.settings.smtp).toBeNull();
			expect(done.settings.rootShellOpenedAlert).toBe(true);

			const audit = await testDb.db
				.selectFrom("audit_events")
				.select(["actor", "target", "action", "result", "metadata"])
				.where("action", "=", "settings.notifications_updated")
				.execute();
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({ target: queued.id, result: "requested" });
			expect(audit[0]?.actor).toMatch(/^user:/);
			expect(audit[0]?.metadata).toEqual({
				job: queued.id,
				changed: ["smtp", "email", "pushover", "webhook", "ntfy", "teams"],
				channels: ["webhook"],
				hosts: ["hooks.example.org"],
				rootShellOpenedAlert: true,
				rootShellOpenedAlertChanged: true,
			});
			expectNoSecret(JSON.stringify(audit));

			const notices = await testDb.db
				.selectFrom("notifications")
				.select(["title", "body", "tone", "site_alert"])
				.execute();
			expect(notices.length).toBeGreaterThan(0);
			expect(notices[0]).toMatchObject({ tone: "warning", site_alert: true });
			expect(notices[0]?.title).toMatch(
				new RegExp(
					`^Notification settings change requested by .* \\(job ${queued.id.slice(0, 8)}\\)$`,
				),
			);
			expectNoSecret(JSON.stringify(notices));
			// The outside alert went through the channels in force before the change.
			await expect.poll(() => tunnels).toContain("hooks.example.com:443");
			expect(tunnels).not.toContain("hooks.example.org:443");
		} finally {
			await app.close();
		}
	});

	test("turning only the root-shell alert on writes the same audit row", async () => {
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const update: NotificationSettingsUpdate = {
				smtp: null,
				alerts: { email: null, pushover: null, webhook: null, ntfy: null, teams: null },
				rootShellOpenedAlert: true,
			};
			expect((await call("PUT", "/admin/notifications", update)).statusCode).toBe(202);
			const [row] = await testDb.db
				.selectFrom("audit_events")
				.select("metadata")
				.where("action", "=", "settings.notifications_updated")
				.execute();
			expect(row?.metadata).toMatchObject({
				changed: [],
				channels: [],
				rootShellOpenedAlert: true,
				rootShellOpenedAlertChanged: true,
			});
		} finally {
			await app.close();
		}
	});

	test("a secret left out stays out of the request, and a refused job shows its code", async () => {
		await writeFile(notifyFile, JSON.stringify(stored));
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const keep: NotificationSettingsUpdate = {
				smtp: {
					...(stored.smtp as NonNullable<NotifyFile["smtp"]>),
					password: undefined,
				},
				alerts: {
					email: stored.alerts.email,
					pushover: {},
					webhook: {},
					ntfy: {},
					teams: {},
				},
				rootShellOpenedAlert: false,
			};
			const put = await call("PUT", "/admin/notifications", keep);
			expect(put.statusCode).toBe(202);
			const [name] = await readdir(jobsDir);
			const text = await readFile(join(jobsDir, name ?? ""), "utf8");
			expectNoSecret(text);
			const [row] = await testDb.db
				.selectFrom("audit_events")
				.select("metadata")
				.where("action", "=", "settings.notifications_updated")
				.execute();
			expect(row?.metadata).toMatchObject({
				changed: [],
				hosts: [
					"smtp.example.edu",
					"hooks.example.com",
					"ntfy.sh",
					"teams.example.com",
				],
			});
			await playJob("refused");
			const view = AdminNotifications.parse(
				(await call("GET", "/admin/notifications")).json(),
			);
			expect(view.job).toMatchObject({ state: "refused", code: "missing_secret" });
		} finally {
			await app.close();
		}
	});

	test("two saves arriving together: one is queued, the other is busy", async () => {
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const answers = await Promise.all([
				call("PUT", "/admin/notifications", webhookOnly),
				call("PUT", "/admin/notifications", webhookOnly),
			]);
			expect(answers.map((r) => r.statusCode).sort()).toEqual([202, 409]);
			expect(
				(await readdir(jobsDir)).filter((n) => n.startsWith("request-")),
			).toHaveLength(1);
		} finally {
			await app.close();
		}
	});

	test("a job stuck running past the unit's timeout no longer blocks a save", async () => {
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const id = "11111111-2222-4333-8444-555555555555";
			await mkdir(join(jobsDir, id));
			const status = (startedAt: string) =>
				JSON.stringify({
					id,
					state: "running",
					code: null,
					channels: [],
					hosts: [],
					requestedAt: null,
					requestedBy: null,
					startedAt,
					finishedAt: null,
				});
			await writeFile(
				join(jobsDir, id, "status.json"),
				status(new Date().toISOString()),
			);
			expect((await call("PUT", "/admin/notifications", webhookOnly)).statusCode).toBe(
				409,
			);
			const old = new Date(Date.now() - STALE_JOB_MS - 1000).toISOString();
			await writeFile(join(jobsDir, id, "status.json"), status(old));
			expect((await call("PUT", "/admin/notifications", webhookOnly)).statusCode).toBe(
				202,
			);
		} finally {
			await app.close();
		}
	});

	test("a request file that cannot be written leaves a second, failed audit row", async () => {
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		await chmod(jobsDir, 0o500);
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			expect((await call("PUT", "/admin/notifications", webhookOnly)).statusCode).toBe(
				500,
			);
			const rows = await testDb.db
				.selectFrom("audit_events")
				.select(["target", "result"])
				.where("action", "=", "settings.notifications_updated")
				.orderBy("id")
				.execute();
			expect(rows.map((r) => r.result)).toEqual(["requested", "failed"]);
			expect(rows[0]?.target).toBe(rows[1]?.target);
		} finally {
			await chmod(jobsDir, 0o700);
			await app.close();
		}
	});

	test("test alerts are limited per administrator and each one is audited", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			for (let i = 0; i < TEST_ALERTS_PER_MINUTE; i++) {
				expect((await call("POST", "/admin/alerts/test")).statusCode).toBe(200);
			}
			const refused = await call("POST", "/admin/alerts/test");
			expect(refused.statusCode).toBe(429);
			expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
			const rows = await testDb.db
				.selectFrom("audit_events")
				.select(["target", "result", "metadata"])
				.where("action", "=", "settings.alert_tested")
				.execute();
			expect(rows).toHaveLength(TEST_ALERTS_PER_MINUTE);
			expect(rows[0]).toMatchObject({
				target: "all",
				result: "ok",
				metadata: { results: [] },
			});
		} finally {
			await app.close();
		}
	});

	test("values the root job refuses are refused first, naming only the fields", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			const smtp = {
				host: "smtp.example.edu",
				port: 587,
				username: "u",
				password: "p",
				from: "a@example.edu",
			};
			const bad: [unknown, string][] = [
				[{ ...webhookOnly, smtp: { ...smtp, host: "10.0.0.1" } }, "smtp.host"],
				[{ ...webhookOnly, smtp: { ...smtp, host: "mail.example.123" } }, "smtp.host"],
				[
					{ ...webhookOnly, smtp: { ...smtp, username: "u\r\nRCPT s3cret" } },
					"smtp.username",
				],
				[{ ...webhookOnly, smtp: { ...smtp, from: "a@example.edu\n" } }, "smtp.from"],
				[
					{
						...webhookOnly,
						alerts: {
							...webhookOnly.alerts,
							webhook: { url: "https://192.168.1.1/new-hook-s3cret" },
						},
					},
					"alerts.webhook.url",
				],
				[
					{
						...webhookOnly,
						alerts: {
							...webhookOnly.alerts,
							teams: { url: "http://teams.example.com/new-hook-s3cret" },
						},
					},
					"alerts.teams.url",
				],
			];
			for (const [payload, field] of bad) {
				const res = await call("PUT", "/admin/notifications", payload);
				expect(res.statusCode, field).toBe(400);
				expect(res.json().message).toContain(field);
				expectNoSecret(res.body);
				expect(res.body).not.toContain("RCPT");
			}
			expect(await readdir(jobsDir)).toEqual([]);
			expect(
				await testDb.db
					.selectFrom("audit_events")
					.select("id")
					.where("action", "=", "settings.notifications_updated")
					.execute(),
			).toEqual([]);
		} finally {
			await app.close();
		}
	});
});
