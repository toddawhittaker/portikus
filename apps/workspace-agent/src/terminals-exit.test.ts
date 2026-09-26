import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "./server.js";
import { readTerminalsExit } from "./terminals.js";

/** The terminals unit's exit record, read for the control plane (SPEC.md §9.7). */

const TOKEN = "exit-record-token";
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-exit-"));
});

test("a record gives its result and the time it was written", async () => {
	const path = join(dir, "oom");
	await writeFile(path, "oom-kill\n");
	const when = new Date("2026-09-26T10:00:00Z");
	await utimes(path, when, when);
	expect(await readTerminalsExit(path)).toEqual({
		result: "oom-kill",
		at: when.toISOString(),
	});
});

test("no record, as on an older image, gives null", async () => {
	expect(await readTerminalsExit(join(dir, "missing"))).toBeNull();
});

test("a record that is not a plain result word gives null", async () => {
	const path = join(dir, "junk");
	await writeFile(path, "<script>alert(1)</script>\n");
	expect(await readTerminalsExit(path)).toBeNull();
	await writeFile(path, "");
	expect(await readTerminalsExit(path)).toBeNull();
});

test("a symlink, a FIFO, or an overlong record gives null", async () => {
	const target = join(dir, "target");
	await writeFile(target, "oom-kill\n");
	const link = join(dir, "link");
	await symlink(target, link);
	expect(await readTerminalsExit(link)).toBeNull();
	const fifo = join(dir, "fifo");
	execFileSync("mkfifo", [fifo]);
	expect(await readTerminalsExit(fifo)).toBeNull();
	const long = join(dir, "long");
	await writeFile(long, `${"a".repeat(64)}b\n`);
	expect(await readTerminalsExit(long)).toBeNull();
});

let app: ReturnType<typeof buildServer> | undefined;

afterAll(async () => {
	await app?.close();
});

test("the route reports the record, or null", async () => {
	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const path = join(dir, "last-exit");
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir: dir,
		terminalsExitPath: path,
	});
	const headers = { authorization: `Bearer ${TOKEN}` };

	const none = await app.inject({
		method: "GET",
		url: "/terminals/last-exit",
		headers,
	});
	expect(none.statusCode).toBe(200);
	expect(none.json()).toEqual({ exit: null });

	await writeFile(path, "signal\n");
	const some = await app.inject({
		method: "GET",
		url: "/terminals/last-exit",
		headers,
	});
	expect(some.json().exit.result).toBe("signal");

	const refused = await app.inject({ method: "GET", url: "/terminals/last-exit" });
	expect(refused.statusCode).toBe(401);
});
