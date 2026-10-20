import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_FILE_OFF, type NotifySmtp } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { MailTransportFactory } from "@portikus/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetMessage } from "./messages.js";
import { type AccountEmailDeps, sendAccountEmail } from "./send.js";

/** Account email goes out only with the switch on and SMTP set (SPEC.md section 5.3). */

const skip = !hasTestDb();

const smtp: NotifySmtp = {
	host: "smtp.example.edu",
	port: 587,
	username: "portikus",
	password: "smtp-pass",
	from: "Portikus <portikus@example.edu>",
};

function fakeTransport(fail = false) {
	const mail: Record<string, unknown>[] = [];
	const factory = (() => ({
		sendMail: async (message: Record<string, unknown>) => {
			if (fail) throw Object.assign(new Error("550 no"), { code: "EENVELOPE" });
			mail.push(message);
			return {};
		},
		close: () => {},
	})) as unknown as MailTransportFactory;
	return { factory, mail };
}

describe.skipIf(skip)("sending account email", () => {
	let t: TestDb;
	let dir: string;
	let notifyFile: string;
	const message = resetMessage("https://portikus.school.edu", "a".repeat(43));

	beforeAll(async () => {
		t = await createTestDb();
		dir = await mkdtemp(join(tmpdir(), "account-email-"));
		notifyFile = join(dir, "notify.json");
	});
	afterAll(async () => {
		await t?.close();
		await rm(dir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		await t.truncate();
		await writeFile(notifyFile, JSON.stringify({ ...NOTIFY_FILE_OFF, smtp }));
	});

	const switchOn = (on: boolean) =>
		t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600, account_email_enabled: on })
			.execute();

	const deps = (extra: Partial<AccountEmailDeps> = {}): AccountEmailDeps => ({
		db: t.db,
		notifyFile,
		...extra,
	});

	test("with the switch off nothing is sent, even with SMTP set", async () => {
		await switchOn(false);
		const { factory, mail } = fakeTransport();
		expect(
			await sendAccountEmail(
				deps({ transportFactory: factory }),
				"a@example.edu",
				message,
			),
		).toEqual({ ok: false, reason: "disabled" });
		expect(mail).toEqual([]);
	});

	test("a site with no settings row has the switch off", async () => {
		const { factory, mail } = fakeTransport();
		expect(
			await sendAccountEmail(
				deps({ transportFactory: factory }),
				"a@example.edu",
				message,
			),
		).toEqual({ ok: false, reason: "disabled" });
		expect(mail).toEqual([]);
	});

	test("with the switch on but no SMTP server nothing is sent", async () => {
		await switchOn(true);
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		const { factory, mail } = fakeTransport();
		expect(
			await sendAccountEmail(
				deps({ transportFactory: factory }),
				"a@example.edu",
				message,
			),
		).toEqual({ ok: false, reason: "no-smtp" });
		expect(mail).toEqual([]);
	});

	test("with the switch on and SMTP set the message goes to the one address through the proxy", async () => {
		await switchOn(true);
		const { factory, mail } = fakeTransport();
		expect(
			await sendAccountEmail(
				deps({ transportFactory: factory, proxyUrl: "http://127.0.0.1:3128" }),
				"a@example.edu",
				message,
			),
		).toEqual({ ok: true });
		expect(mail).toEqual([
			{
				from: smtp.from,
				to: "a@example.edu",
				subject: message.subject,
				text: message.text,
			},
		]);
	});

	test("a server that refuses the message is reported as failed, without its reply", async () => {
		await switchOn(true);
		const { factory } = fakeTransport(true);
		expect(
			await sendAccountEmail(
				deps({ transportFactory: factory }),
				"a@example.edu",
				message,
			),
		).toEqual({ ok: false, reason: "failed" });
	});

	test("the capture file takes the message instead of SMTP, still only with the switch on", async () => {
		const captureFile = join(dir, "mail.jsonl");
		await rm(captureFile, { force: true });
		await writeFile(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
		expect(
			await sendAccountEmail(deps({ captureFile }), "a@example.edu", message),
		).toEqual({
			ok: false,
			reason: "disabled",
		});
		await switchOn(true);
		expect(
			await sendAccountEmail(deps({ captureFile }), "a@example.edu", message),
		).toEqual({
			ok: true,
		});
		const captured = JSON.parse((await readFile(captureFile, "utf8")).trim());
		expect(captured.subject).toBe(message.subject);
		expect(captured.text).toBe(message.text);
	});
});
