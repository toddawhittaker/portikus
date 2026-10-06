import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { runAlertCommand } from "./alert-command.js";

interface Received {
	path: string;
	type: string;
	body: string;
}

let server: Server | undefined;

/** A local receiver that records each request; a path with "fail" gets a 500. */
async function receiver(): Promise<{ url: string; got: Received[] }> {
	const got: Received[] = [];
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			got.push({ path: req.url ?? "", type: req.headers["content-type"] ?? "", body });
			res.statusCode = req.url?.includes("fail") ? 500 : 200;
			res.end();
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

async function run(args: string[], env: NodeJS.ProcessEnv, pushoverUrl?: string) {
	const lines: string[] = [];
	const errors: string[] = [];
	const code = await runAlertCommand(
		args,
		env,
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

	test("with no channel set it sends nothing and succeeds", async () => {
		const { code, lines } = await run(["danger", "T", "X"], {
			ALERT_PUSHOVER_USER_KEY: "u",
			ALERT_PUSHOVER_APP_TOKEN: "",
			ALERT_WEBHOOK_URL: "",
		});
		expect(code).toBe(0);
		expect(lines).toEqual([
			"portikus: no alert channel is set in alerts.env; nothing sent",
		]);
	});

	test("the webhook gets the worker's body, title and text as given", async () => {
		const hook = await receiver();
		const title = 'Backup "nightly" failed';
		const text = "Line one\nback\\slash and 100% done";
		const { code, lines } = await run(["warning", title, text], {
			ALERT_WEBHOOK_URL: `${hook.url}/hook/s3cret?x=1&y=2`,
		});
		expect(code).toBe(0);
		expect(lines).toEqual(["portikus: the webhook alert was sent"]);
		expect(hook.got).toHaveLength(1);
		expect(hook.got[0]?.path).toBe("/hook/s3cret?x=1&y=2");
		expect(hook.got[0]?.type).toBe("application/json");
		const body = JSON.parse(hook.got[0]?.body ?? "");
		expect(Object.keys(body).sort()).toEqual(["at", "site", "text", "title", "tone"]);
		expect(body).toMatchObject({
			title,
			text: `${title}\n${text}`,
			tone: "warning",
			site: "site-a",
		});
	});

	test("both channels go through OUTBOUND_PROXY_URL, and one failure fails the run", async () => {
		const proxy = await receiver();
		const { code, lines, errors } = await run(
			["danger", "T", "X"],
			{
				ALERT_PUSHOVER_USER_KEY: "u",
				ALERT_PUSHOVER_APP_TOKEN: "a",
				ALERT_WEBHOOK_URL: "http://hooks.example.invalid/fail",
				OUTBOUND_PROXY_URL: proxy.url,
			},
			"http://pushover.example.invalid/1/messages.json",
		);
		expect(proxy.got.map((g) => g.path)).toEqual([
			"http://pushover.example.invalid/1/messages.json",
			"http://hooks.example.invalid/fail",
		]);
		expect(new URLSearchParams(proxy.got[0]?.body).get("priority")).toBe("1");
		// A failure goes to stderr, so a caller's log shows it as an error.
		expect(lines).toEqual(["portikus: the pushover alert was sent"]);
		expect(errors).toEqual([
			"portikus: the webhook alert could not be sent (HTTP 500)",
		]);
		expect(code).toBe(1);
	});
});
