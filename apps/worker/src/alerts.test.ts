import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_FILE_OFF, type NotifyFile } from "@portikus/contracts";
import { notifyAdministrators, recordNotification } from "@portikus/db";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import {
	type Alert,
	type AlertChannels,
	readAlertChannels,
} from "@portikus/observability";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	ALERT_QUIET_MS,
	ALERTS_PER_HOUR,
	AlertGate,
	createAlertForwarder,
	TRIAGE_WAIT_MS,
} from "./alerts.js";

const T0 = new Date("2026-10-04T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("flood control", () => {
	test("the same key fires once while it keeps recurring", () => {
		const gate = new AlertGate();
		expect(gate.admit("disk", T0)).toBe(true);
		expect(gate.admit("disk", at(10 * 60_000))).toBe(false);
		// Still recurring: each sighting extends the quiet period.
		expect(gate.admit("disk", at(10 * 60_000 + ALERT_QUIET_MS))).toBe(false);
		expect(gate.admit("other", at(1000))).toBe(true);
	});

	test("a key fires again after an hour without it", () => {
		const gate = new AlertGate();
		expect(gate.admit("disk", T0)).toBe(true);
		expect(gate.admit("disk", at(ALERT_QUIET_MS + 1))).toBe(true);
	});

	test("no more than the hourly cap leave in a rolling hour", () => {
		const gate = new AlertGate();
		for (let i = 0; i < ALERTS_PER_HOUR; i++)
			expect(gate.admit(`k${i}`, at(i))).toBe(true);
		expect(gate.admit("one-too-many", at(ALERTS_PER_HOUR))).toBe(false);
		expect(gate.admit("an-hour-later", at(60 * 60_000 + 1))).toBe(true);
	});
});

const skip = !hasTestDb();
let tdb: TestDb;
const channels: AlertChannels = {
	pushoverUserKey: "",
	pushoverAppToken: "",
	webhookUrl: "http://127.0.0.1:1/hook",
};

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
});

describe.skipIf(skip)("forwarding", () => {
	test("sends each new warning or danger admin notification once", async () => {
		await insertTestUser(tdb.db, { role: "administrator" });
		await insertTestUser(tdb.db, { role: "administrator" });
		const student = await insertTestUser(tdb.db);
		const sent: Alert[] = [];
		const { logger } = collectingLogger();
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => channels,
			now: () => new Date(Date.now() - 1000),
			send: async (alert) => {
				sent.push(alert);
				return [{ channel: "webhook", ok: true }];
			},
		});
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await notifyAdministrators(tdb.db, { tone: "neutral", title: "Info", body: "b" });
		await tdb.db
			.insertInto("notifications")
			.values({ user_id: student, tone: "danger", title: "Student only", body: "" })
			.execute();
		await tick();
		await tick();
		expect(sent.map((a) => [a.tone, a.title, a.text])).toEqual([
			["danger", "Down", "b"],
		]);
	});

	// SPEC.md section 24.12: only site conditions leave the site.
	test("a personal notice to an administrator is not forwarded", async () => {
		const admin = await insertTestUser(tdb.db, { role: "administrator" });
		const sent: Alert[] = [];
		const { logger } = collectingLogger();
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => channels,
			now: () => new Date(Date.now() - 1000),
			send: async (alert) => {
				sent.push(alert);
				return [{ channel: "webhook", ok: true }];
			},
		});
		await recordNotification(
			tdb.db,
			admin,
			{ tone: "warning", title: "An administrator reset your password", body: "b" },
			{ kept: true },
		);
		await recordNotification(tdb.db, admin, {
			tone: "danger",
			title: "Your home folder was not replaced",
			body: "b",
		});
		await notifyAdministrators(tdb.db, { tone: "warning", title: "Disk", body: "b" });
		await tick();
		expect(sent.map((a) => a.title)).toEqual(["Disk"]);
	});

	// PostgreSQL keeps microseconds and a Date only milliseconds, so a row's
	// own time must not make it newer than the tick that already read it.
	test("a row with sub-millisecond time is read once, not on every tick", async () => {
		const admin = await insertTestUser(tdb.db, { role: "administrator" });
		const { logger, lines } = collectingLogger();
		let calls = 0;
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => channels,
			now: () => new Date(Date.now() - 1000),
			send: async () => {
				calls++;
				return [{ channel: "webhook", ok: true }];
			},
		});
		await tdb.db
			.insertInto("notifications")
			.values({
				user_id: admin,
				tone: "warning",
				title: "Reboot",
				body: "b",
				site_alert: true,
				created_at: sql<string>`date_trunc('milliseconds', clock_timestamp()) + interval '500 microseconds'`,
			})
			.execute();
		await tick();
		await tick();
		await tick();
		expect(calls).toBe(1);
		expect(JSON.stringify(lines)).not.toContain("held back by flood control");
	});

	test("does nothing when no channel is configured", async () => {
		await insertTestUser(tdb.db, { role: "administrator" });
		let calls = 0;
		const { logger } = collectingLogger();
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => ({ ...channels, webhookUrl: "" }),
			now: () => new Date(Date.now() - 1000),
			send: async () => {
				calls++;
				return [];
			},
		});
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await tick();
		expect(calls).toBe(0);
	});

	test("a failed send is logged without the webhook URL", async () => {
		await insertTestUser(tdb.db, { role: "administrator" });
		const { logger, lines } = collectingLogger();
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => channels,
			now: () => new Date(Date.now() - 1000),
		});
		await notifyAdministrators(tdb.db, { tone: "warning", title: "Disk", body: "b" });
		await tick();
		const text = JSON.stringify(lines);
		expect(text).toContain("alert could not be sent");
		expect(text).not.toContain("/hook");
	});

	describe("reading notify.json (ADR 0052)", () => {
		let dir = "";
		let path = "";
		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "worker-notify-"));
			path = join(dir, "notify.json");
		});
		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		const withWebhook: NotifyFile = {
			...NOTIFY_FILE_OFF,
			alerts: {
				...NOTIFY_FILE_OFF.alerts,
				webhook: { url: "https://hooks.example.com/services/s3cret" },
			},
		};

		function forwarder(sent: [Alert, AlertChannels][]) {
			const { logger, lines } = collectingLogger();
			const tick = createAlertForwarder({
				db: tdb.db,
				logger,
				loadChannels: () => readAlertChannels(path, "http://127.0.0.1:3128"),
				now: () => new Date(Date.now() - 1000),
				send: async (alert, channels) => {
					sent.push([alert, channels]);
					return [{ channel: "webhook", ok: true }];
				},
			});
			return { tick, lines };
		}

		test("a settings change is used at the next tick, with no restart", async () => {
			await insertTestUser(tdb.db, { role: "administrator" });
			await writeFile(path, JSON.stringify(withWebhook));
			const sent: [Alert, AlertChannels][] = [];
			const { tick } = forwarder(sent);
			await notifyAdministrators(tdb.db, { tone: "danger", title: "One", body: "b" });
			await tick();
			expect(sent.map(([a, c]) => [a.title, c.webhookUrl, c.proxyUrl])).toEqual([
				["One", "https://hooks.example.com/services/s3cret", "http://127.0.0.1:3128"],
			]);
			await writeFile(path, JSON.stringify(NOTIFY_FILE_OFF));
			await notifyAdministrators(tdb.db, { tone: "danger", title: "Two", body: "b" });
			await tick();
			expect(sent).toHaveLength(1);
		});

		test("alerts raised while every channel was off are not sent once one is on", async () => {
			await insertTestUser(tdb.db, { role: "administrator" });
			const sent: [Alert, AlertChannels][] = [];
			const { tick } = forwarder(sent);
			await notifyAdministrators(tdb.db, { tone: "danger", title: "Old", body: "b" });
			await tick();
			await writeFile(path, JSON.stringify(withWebhook));
			await notifyAdministrators(tdb.db, { tone: "danger", title: "New", body: "b" });
			await tick();
			expect(sent.map(([a]) => a.title)).toEqual(["New"]);
		});

		test("alert email gets site alerts such as a certificate notice", async () => {
			await insertTestUser(tdb.db, { role: "administrator" });
			const smtp = {
				host: "smtp.example.edu",
				port: 587 as const,
				username: "",
				password: "",
				from: "portikus@example.edu",
			};
			await writeFile(
				path,
				JSON.stringify({
					...NOTIFY_FILE_OFF,
					smtp,
					alerts: { ...NOTIFY_FILE_OFF.alerts, email: { to: ["ops@example.edu"] } },
				}),
			);
			const sent: [Alert, AlertChannels][] = [];
			const { tick } = forwarder(sent);
			await notifyAdministrators(tdb.db, {
				tone: "danger",
				title: "A certificate did not renew",
				body: "b",
			});
			await tick();
			expect(sent.map(([a, c]) => [a.title, c.email])).toEqual([
				["A certificate did not renew", { smtp, to: ["ops@example.edu"] }],
			]);
		});

		test("an unreadable file is logged by name only and sends nothing", async () => {
			await insertTestUser(tdb.db, { role: "administrator" });
			await writeFile(path, '{"version": 1, "secret": "s3cret"');
			const sent: [Alert, AlertChannels][] = [];
			const { tick, lines } = forwarder(sent);
			await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
			await tick();
			expect(sent).toEqual([]);
			const text = JSON.stringify(lines);
			expect(text).toContain("alert settings could not be read");
			expect(text).not.toContain("s3cret");
			// Held, not dropped: it goes out once the file reads again.
			await writeFile(path, JSON.stringify(withWebhook));
			await tick();
			expect(sent.map(([a]) => a.title)).toEqual(["Down"]);
		});
	});
});

// SPEC.md section 20.4: with the switch on, email and Pushover wait up to a
// minute for the API's stored explanation; the worker never calls a model.
describe.skipIf(skip)("alert explanations", () => {
	const all = {
		pushoverUserKey: "user",
		pushoverAppToken: "app",
		webhookUrl: "http://127.0.0.1:1/hook",
		email: { smtp: {}, to: ["ops@example.edu"] },
	} as unknown as AlertChannels;

	async function switches(enabled: boolean, forward: boolean) {
		await tdb.db
			.updateTable("ai_settings")
			.set({ triage_enabled: enabled, triage_forward: forward })
			.execute();
	}

	async function explain(title: string, text: string) {
		await tdb.db
			.updateTable("notifications")
			.set({ triage: text, triaged_at: new Date().toISOString() })
			.where("title", "=", title)
			.execute();
	}

	/** A forwarder on a fake clock; `onSleep` runs at each wait. */
	function forwarder(channels: AlertChannels, onSleep?: (n: number) => Promise<void>) {
		let clock = Date.now() - 1000;
		let waited = 0;
		const sent: [Alert, AlertChannels][] = [];
		const { logger } = collectingLogger();
		const tick = createAlertForwarder({
			db: tdb.db,
			logger,
			loadChannels: async () => channels,
			now: () => new Date(clock),
			sleep: async (ms) => {
				clock += ms;
				waited += ms;
				await onSleep?.(waited);
			},
			send: async (alert, to) => {
				sent.push([alert, to]);
				return [];
			},
		});
		return { tick, sent, waited: () => waited };
	}

	beforeEach(async () => {
		await insertTestUser(tdb.db, { role: "administrator" });
		await insertTestUser(tdb.db, { role: "administrator" });
	});

	test("appends a stored explanation to email and Pushover only", async () => {
		await switches(true, true);
		const f = forwarder(all);
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await explain("Down", "The controller stopped.");
		await f.tick();
		expect(f.waited()).toBe(0);
		expect(f.sent).toHaveLength(2);
		const [[withText, to], [plain, rest]] = f.sent as [
			[Alert, AlertChannels],
			[Alert, AlertChannels],
		];
		expect(withText.text).toBe("b\n\nAI explanation: The controller stopped.");
		expect(to).toMatchObject({ pushoverUserKey: "user", webhookUrl: "" });
		expect(to.email).toBeTruthy();
		expect(plain.text).toBe("b");
		expect(rest).toMatchObject({ pushoverUserKey: "", email: null });
		expect(rest.webhookUrl).toBe(all.webhookUrl);
	});

	test("waits for an explanation written after the alert", async () => {
		await switches(true, true);
		const f = forwarder(all, async (waited) => {
			if (waited >= 10_000) await explain("Disk", "The pool is full.");
		});
		await notifyAdministrators(tdb.db, { tone: "warning", title: "Disk", body: "b" });
		await f.tick();
		expect(f.waited()).toBeGreaterThanOrEqual(10_000);
		expect(f.waited()).toBeLessThan(TRIAGE_WAIT_MS);
		expect(f.sent[0]?.[0].text).toContain("AI explanation: The pool is full.");
	});

	test("sends as before when no explanation comes within the minute", async () => {
		await switches(true, true);
		const f = forwarder(all);
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await f.tick();
		expect(f.waited()).toBeGreaterThan(TRIAGE_WAIT_MS - 5_000);
		expect(f.waited()).toBeLessThanOrEqual(TRIAGE_WAIT_MS + 2_000);
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]?.[0].text).toBe("b");
		expect(f.sent[0]?.[1]).toBe(all);
	});

	test.each([
		["the forward switch is off", true, false, all],
		["explanations are off", false, true, all],
		[
			"neither email nor Pushover is set",
			true,
			true,
			{ ...all, pushoverUserKey: "", email: null },
		],
	])("neither waits nor appends when %s", async (_name, enabled, forward, channels) => {
		await switches(enabled, forward);
		const f = forwarder(channels as AlertChannels);
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await explain("Down", "The controller stopped.");
		await f.tick();
		expect(f.waited()).toBe(0);
		expect(f.sent.map(([a]) => a.text)).toEqual(["b"]);
	});

	test("an older alert's explanation is not used for a new one", async () => {
		await switches(true, true);
		const admin = (
			await tdb.db.selectFrom("users").select("id").limit(1).executeTakeFirstOrThrow()
		).id;
		await tdb.db
			.insertInto("notifications")
			.values({
				user_id: admin,
				tone: "danger",
				title: "Down",
				body: "b",
				site_alert: true,
				created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				triage: "Old explanation.",
			})
			.execute();
		const f = forwarder(all);
		await notifyAdministrators(tdb.db, { tone: "danger", title: "Down", body: "b" });
		await f.tick();
		expect(f.sent.map(([a]) => a.text)).toEqual(["b"]);
	});
});
