import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
	AppServerClient,
	AppServerGone,
	RpcError,
	spawnAppServer,
} from "./app-server.js";
import { FakeAppServer } from "./fake-app-server.js";

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-app-server-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function client(server: FakeAppServer) {
	const notifications: [string, unknown][] = [];
	const requests: [unknown, string, unknown][] = [];
	let exits = 0;
	const rpc = new AppServerClient(server, {
		notification: (method, params) => notifications.push([method, params]),
		request: (id, method, params) => requests.push([id, method, params]),
		exit: () => {
			exits += 1;
		},
	});
	return { rpc, notifications, requests, exits: () => exits };
}

test("answers, errors, notifications and server requests each reach their place", async () => {
	const server = new FakeAppServer({});
	const { rpc, notifications, requests } = client(server);
	const answered = rpc.request("model/list", { limit: 1 });
	const refused = rpc.request("thread/resume");
	await vi.waitFor(() => expect(server.sent).toHaveLength(2));
	expect(server.sent[0]).toEqual({ id: 1, method: "model/list", params: { limit: 1 } });
	server.stdout.write("not json\n42\n");
	server.push({ id: 99, result: {} });
	server.push({ id: 1, result: { data: [] } });
	server.push({ id: 2, error: { code: -32600, message: "no rollout" } });
	server.push({ method: "turn/started", params: { threadId: "t" } });
	server.push({ method: "item/tool/requestUserInput", id: 0, params: { itemId: "q" } });
	await expect(answered).resolves.toEqual({ data: [] });
	await expect(refused).rejects.toEqual(new RpcError(-32600, "no rollout"));
	await vi.waitFor(() => expect(requests).toHaveLength(1));
	expect(notifications).toEqual([["turn/started", { threadId: "t" }]]);
	expect(requests).toEqual([[0, "item/tool/requestUserInput", { itemId: "q" }]]);
	rpc.notify("initialized");
	rpc.respond(0, { answers: {} });
	rpc.respondError(5, -32601, "no");
	await vi.waitFor(() => expect(server.sent).toHaveLength(5));
	expect(server.sent.slice(2)).toEqual([
		{ method: "initialized", params: {} },
		{ id: 0, result: { answers: {} } },
		{ id: 5, error: { code: -32601, message: "no" } },
	]);
});

test("an error answer without a message still rejects plainly", async () => {
	const server = new FakeAppServer({});
	const { rpc } = client(server);
	const pending = rpc.request("x");
	server.push({ id: 1, error: null });
	await expect(pending).rejects.toBeInstanceOf(RpcError);
});

test("when the process ends, waiting requests fail and later ones are refused", async () => {
	const server = new FakeAppServer({});
	const { rpc, exits } = client(server);
	const pending = rpc.request("turn/start");
	server.exit();
	await expect(pending).rejects.toBeInstanceOf(AppServerGone);
	await expect(rpc.request("turn/start")).rejects.toBeInstanceOf(AppServerGone);
	expect(rpc.running).toBe(false);
	rpc.stop();
	expect(exits()).toBe(1);
});

test("a real child speaks over its pipes, and one that cannot start ends", async () => {
	const script = join(dir, "fake-codex");
	await writeFile(
		script,
		'#!/bin/sh\n[ "$1" = app-server ] || exit 2\necho oops >&2\nread line\necho \'{"id":1,"result":{"ok":true}}\'\nsleep 5\n',
	);
	await chmod(script, 0o755);
	let ended = false;
	const rpc = new AppServerClient(spawnAppServer(script, dir), {
		notification: () => undefined,
		request: () => undefined,
		exit: () => {
			ended = true;
		},
	});
	await expect(rpc.request("initialize")).resolves.toEqual({ ok: true });
	rpc.stop();
	expect(ended).toBe(true);

	let missingEnded = false;
	const missing = new AppServerClient(spawnAppServer(join(dir, "no-such-codex"), dir), {
		notification: () => undefined,
		request: () => undefined,
		exit: () => {
			missingEnded = true;
		},
	});
	await expect(missing.request("initialize")).rejects.toBeInstanceOf(AppServerGone);
	expect(missingEnded).toBe(true);
});
