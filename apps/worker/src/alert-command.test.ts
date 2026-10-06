import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_FILE_OFF, type NotifyFile } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAlertCommand } from "./alert-command.js";

interface Received {
	method: string;
	path: string;
	body: string;
}

let server: Server | undefined;
let dir = "";
let notifyFile = "";

/**
 * A fake egress proxy that records each request. A plain request gets 200;
 * a CONNECT tunnel is refused, as Squid refuses a host it does not list.
 */
async function proxy(): Promise<{ url: string; got: Received[] }> {
	const got: Received[] = [];
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			got.push({ method: req.method ?? "", path: req.url ?? "", body });
			res.end();
		});
	});
	server.on("connect", (req, socket) => {
		got.push({ method: "CONNECT", path: req.url ?? "", body: "" });
		socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, got };
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "alert-command-"));
	notifyFile = join(dir, "notify.json");
});

afterEach(async () => {
	await new Promise((r) => (server ? server.close(r) : r(undefined)));
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

function settings(alerts: Partial<NotifyFile["alerts"]>): string {
	return JSON.stringify({
		...NOTIFY_FILE_OFF,
		alerts: { ...NOTIFY_FILE_OFF.alerts, ...alerts },
	});
}

async function run(args: string[], env: NodeJS.ProcessEnv, pushoverUrl?: string) {
	const lines: string[] = [];
	const errors: string[] = [];
	const code = await runAlertCommand(
		args,
		{ NOTIFY_FILE: notifyFile, ...env },
		(l) => lines.push(l),
		(l) => errors.push(l),
		"site-a",
		pushoverUrl,
	);
	return { code, lines, errors };
}

describe("portikus alert (STACK.md section 15)", () => {
	test("a tone other than warning or danger, or a missing text, is a usage error", async () => {
		expect((await run(["info", "T", "X"], {})).code).toBe(2);
		expect((await run(["warning", "T"], {})).code).toBe(2);
	});

	test("with no notify.json it sends nothing and succeeds", async () => {
		const { code, lines } = await run(["danger", "T", "X"], {});
		expect(code).toBe(0);
		expect(lines).toEqual([
			`portikus: no alert channel is set in ${notifyFile}; nothing sent`,
		]);
	});

	test("an unreadable notify.json fails the run and names only the file", async () => {
		await writeFile(notifyFile, settings({ webhook: { url: "not a url s3cret" } }));
		const { code, lines, errors } = await run(["danger", "T", "X"], {});
		expect(code).toBe(1);
		expect(lines).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(notifyFile);
		expect(errors[0]).not.toContain("s3cret");
	});

	test("channels come from notify.json and go through OUTBOUND_PROXY_URL; one failure fails the run", async () => {
		const egress = await proxy();
		await writeFile(
			notifyFile,
			settings({
				pushover: { userKey: "u", appToken: "a" },
				webhook: { url: "https://hooks.example.com/services/s3cret" },
			}),
		);
		const { code, lines, errors } = await run(
			["danger", "T", "X"],
			{ OUTBOUND_PROXY_URL: egress.url },
			"http://pushover.example.invalid/1/messages.json",
		);
		expect(egress.got.map((g) => [g.method, g.path])).toEqual([
			["POST", "http://pushover.example.invalid/1/messages.json"],
			["CONNECT", "hooks.example.com:443"],
		]);
		const form = new URLSearchParams(egress.got[0]?.body);
		expect([form.get("user"), form.get("token"), form.get("priority")]).toEqual([
			"u",
			"a",
			"1",
		]);
		// A failure goes to stderr, so a caller's log shows it as an error.
		expect(lines).toEqual(["portikus: the pushover alert was sent"]);
		expect(errors).toEqual([
			"portikus: the webhook alert could not be sent (unreachable)",
		]);
		expect(code).toBe(1);
	});
});
