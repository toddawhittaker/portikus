import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DEFAULT_REQUEST_TIMEOUT_MS, IncusClient, IncusError } from "./incus.js";

let socketPath: string;
let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void = (
	_req,
	socket,
) => socket.destroy();

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incus-test-"));
	socketPath = path.join(dir, "test.sock");
	server = http.createServer((req, res) => handler(req, res));
	server.on("upgrade", (req, socket, head) => upgrade(req, socket, head));
	await new Promise<void>((r) => server.listen(socketPath, r));
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve())),
	);
	if (fs.existsSync(socketPath)) {
		fs.unlinkSync(socketPath);
	}
});

function respond(res: http.ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(json);
}

// Incus answers an operation wait with a plain success reply whatever the
// operation's outcome; the outcome is in the operation it carries.
function waitReply(operation: Record<string, unknown>) {
	return { type: "sync", status: "Success", status_code: 200, metadata: operation };
}

test("sync envelope returns metadata", async () => {
	handler = (_req, res) => {
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: { name: "test" },
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	const result = await client.request("GET", "/1.0/test");
	expect(result).toEqual({ name: "test" });
});

test("project query param on every request", async () => {
	let receivedUrl = "";
	handler = (req, res) => {
		receivedUrl = req.url ?? "";
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "myproject",
	});
	await client.request("GET", "/1.0/test");
	expect(receivedUrl).toContain("project=myproject");
});

test("project appends with & when path has query", async () => {
	let receivedUrl = "";
	handler = (req, res) => {
		receivedUrl = req.url ?? "";
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "myproject",
	});
	await client.request("GET", "/1.0/test?recursion=2");
	expect(receivedUrl).toContain("recursion=2&project=myproject");
});

test("async envelope followed by wait success", async () => {
	let callCount = 0;
	handler = (_req, res) => {
		callCount++;
		if (callCount === 1) {
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/op1",
				metadata: { id: "op1" },
			});
		} else {
			respond(
				res,
				200,
				waitReply({ status_code: 200, status: "Success", metadata: { done: true } }),
			);
		}
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	const result = await client.request("POST", "/1.0/instances", {
		name: "test",
	});
	expect(result).toMatchObject({ status_code: 200, metadata: { done: true } });
	expect(callCount).toBe(2);
});

test("wait 103 maps to TIMEOUT", async () => {
	let callCount = 0;
	handler = (_req, res) => {
		callCount++;
		if (callCount === 1) {
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/op2",
			});
		} else {
			respond(res, 200, waitReply({ status_code: 103, status: "Running", err: "" }));
		}
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	try {
		await client.request("PUT", "/1.0/instances/x/state", {
			action: "stop",
		});
		expect.fail("should have thrown");
	} catch (err) {
		expect(err).toBeInstanceOf(IncusError);
		expect((err as IncusError).code).toBe("TIMEOUT");
	}
});

test("a failed operation maps to OPERATION_FAILED with Incus's message", async () => {
	handler = (req, res) => {
		if (req.url?.includes("/wait")) {
			respond(
				res,
				200,
				waitReply({
					status_code: 400,
					status: "Failure",
					err: 'Failed shutting down instance, status is "Running": context deadline exceeded',
				}),
			);
			return;
		}
		respond(res, 202, {
			type: "async",
			status: "Operation created",
			status_code: 100,
			operation: "/1.0/operations/op3",
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(
		client.request("PUT", "/1.0/instances/x/state", { action: "stop" }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
		message:
			'Failed shutting down instance, status is "Running": context deadline exceeded',
	});
});

test("a pool that fills during an operation maps to STORAGE_FULL", async () => {
	handler = (req, res) => {
		if (req.url?.includes("/wait")) {
			respond(
				res,
				200,
				waitReply({
					status_code: 400,
					status: "Failure",
					err: "write: no space left on device",
				}),
			);
			return;
		}
		respond(res, 202, {
			type: "async",
			status: "Operation created",
			status_code: 100,
			operation: "/1.0/operations/op4",
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(client.request("POST", "/1.0/instances", {})).rejects.toMatchObject({
		code: "STORAGE_FULL",
	});
});

test("404 maps to NOT_FOUND", async () => {
	handler = (_req, res) => {
		respond(res, 404, {
			type: "error",
			status: "Not found",
			status_code: 404,
			error: "Instance not found",
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	try {
		await client.request("GET", "/1.0/instances/missing");
		expect.fail("should have thrown");
	} catch (err) {
		expect(err).toBeInstanceOf(IncusError);
		expect((err as IncusError).code).toBe("NOT_FOUND");
	}
});

test("409 maps to ALREADY_EXISTS", async () => {
	handler = (_req, res) => {
		respond(res, 409, {
			type: "error",
			status: "Conflict",
			status_code: 409,
			error: "already exists",
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	try {
		await client.request("POST", "/1.0/instances", {});
		expect.fail("should have thrown");
	} catch (err) {
		expect((err as IncusError).code).toBe("ALREADY_EXISTS");
	}
});

test("ECONNREFUSED maps to INCUS_UNAVAILABLE", async () => {
	const client = new IncusClient({
		socketPath: "/tmp/nonexistent-socket-path-xxx.sock",
		project: "testproj",
	});
	try {
		await client.request("GET", "/1.0");
		expect.fail("should have thrown");
	} catch (err) {
		expect(err).toBeInstanceOf(IncusError);
		expect((err as IncusError).code).toBe("INCUS_UNAVAILABLE");
	}
});

test("ping returns true for reachable server", async () => {
	handler = (_req, res) => {
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	expect(await client.ping()).toBe(true);
});

test("ping returns false for unreachable server", async () => {
	const client = new IncusClient({
		socketPath: "/tmp/nonexistent-xxx.sock",
		project: "testproj",
	});
	expect(await client.ping()).toBe(false);
});

test("pushFile sends the files API path, headers, and raw body", async () => {
	let received: {
		method: string;
		url: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	} | null = null;
	handler = (req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			};
			respond(res, 200, {
				type: "sync",
				status: "Success",
				status_code: 200,
				metadata: {},
			});
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await client.pushFile("ws-test", "/etc/portikus/agent.token", "deadbeef", {
		uid: 1000,
		gid: 1000,
		mode: "0600",
	});

	const got = received as unknown as {
		method: string;
		url: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	};
	expect(got.method).toBe("POST");
	expect(got.url).toBe(
		"/1.0/instances/ws-test/files?path=%2Fetc%2Fportikus%2Fagent.token&project=testproj",
	);
	expect(got.headers["x-incus-uid"]).toBe("1000");
	expect(got.headers["x-incus-gid"]).toBe("1000");
	expect(got.headers["x-incus-mode"]).toBe("0600");
	expect(got.headers["x-incus-type"]).toBe("file");
	expect(got.headers["x-incus-write"]).toBe("overwrite");
	expect(got.headers["content-type"]).toBe("application/octet-stream");
	expect(got.body).toBe("deadbeef");
});

test("pushFile maps a 404 to NOT_FOUND", async () => {
	handler = (req, res) => {
		req.resume();
		req.on("end", () => {
			respond(res, 404, {
				type: "error",
				status: "Not Found",
				status_code: 404,
				error: "instance not found",
			});
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(
		client.pushFile("ws-missing", "/etc/portikus/agent.token", "x", {
			uid: 1000,
			gid: 1000,
			mode: "0600",
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

// ETag-guarded update, used to take a device off an instance (ADR 0021).

test("getWithEtag returns the metadata and the ETag header", async () => {
	let url = "";
	handler = (req, res) => {
		url = req.url ?? "";
		res.writeHead(200, { "Content-Type": "application/json", ETag: '"abc"' });
		res.end(
			JSON.stringify({
				type: "sync",
				status: "Success",
				status_code: 200,
				metadata: { a: 1 },
			}),
		);
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	const result = await client.getWithEtag("/1.0/instances/x");
	expect(result).toEqual({ metadata: { a: 1 }, etag: '"abc"' });
	expect(url).toBe("/1.0/instances/x?project=testproj");
});

test("getWithEtag refuses a response without an ETag", async () => {
	handler = (_req, res) => {
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(client.getWithEtag("/1.0/instances/x")).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
});

test("putIfMatch sends If-Match and the JSON body, then waits for the operation", async () => {
	const seen: Array<{ method: string; url: string; ifMatch: unknown; body: string }> =
		[];
	handler = (req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({
				method: req.method ?? "",
				url: req.url ?? "",
				ifMatch: req.headers["if-match"],
				body: Buffer.concat(chunks).toString(),
			});
			if (req.method === "PUT") {
				respond(res, 202, {
					type: "async",
					status: "Operation created",
					status_code: 100,
					operation: "/1.0/operations/op2",
				});
			} else {
				respond(res, 200, waitReply({ status_code: 200, status: "Success" }));
			}
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await client.putIfMatch("/1.0/instances/x", { devices: {} }, '"abc"');
	expect(seen[0]).toEqual({
		method: "PUT",
		url: "/1.0/instances/x?project=testproj",
		ifMatch: '"abc"',
		body: '{"devices":{}}',
	});
	expect(seen[1]?.url).toContain("/1.0/operations/op2/wait");
});

test("putIfMatch maps a 412 stale ETag to OPERATION_FAILED", async () => {
	handler = (_req, res) => {
		respond(res, 412, {
			type: "error",
			status: "",
			status_code: 0,
			error_code: 412,
			error: "ETag doesn't match",
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	const err = await client.putIfMatch("/1.0/instances/x", {}, '"old"').catch((e) => e);
	expect(err).toBeInstanceOf(IncusError);
	expect(err).toMatchObject({
		code: "OPERATION_FAILED",
		message: "ETag doesn't match",
	});
});

test("a request with no signal times out at the default", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		handler = () => {
			// Never answer.
		};
		const client = new IncusClient({ socketPath, project: "testproj" });
		const caught = client.request("GET", "/1.0/hang").catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
		expect(await Promise.race([caught, Promise.resolve("pending")])).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		const err = await caught;
		expect(err).toBeInstanceOf(IncusError);
		expect((err as IncusError).code).toBe("TIMEOUT");
	} finally {
		vi.useRealTimers();
	}
});

test("a request can be given its own longer bound", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		handler = () => {
			// Never answer.
		};
		const client = new IncusClient({ socketPath, project: "testproj" });
		const caught = client
			.request("POST", "/1.0/hang", {}, undefined, undefined, 60_000)
			.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(await Promise.race([caught, Promise.resolve("pending")])).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		expect((await caught) as IncusError).toMatchObject({ code: "TIMEOUT" });
	} finally {
		vi.useRealTimers();
	}
});

test("an operation wait is bounded at its own timeout plus 5 seconds", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		let waitArrived = (): void => {};
		const waiting = new Promise<void>((r) => {
			waitArrived = r;
		});
		handler = (req, res) => {
			if (req.url?.includes("/wait")) {
				waitArrived(); // and never answer
				return;
			}
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/op1",
			});
		};
		const client = new IncusClient({ socketPath, project: "testproj" });
		const caught = client
			.request("POST", "/1.0/instances", {}, undefined, 100)
			.catch((e: unknown) => e);
		await waiting;
		await vi.advanceTimersByTimeAsync(104_000);
		expect(await Promise.race([caught, Promise.resolve("pending")])).toBe("pending");
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await caught) as IncusError).toMatchObject({ code: "TIMEOUT" });
	} finally {
		vi.useRealTimers();
	}
});

interface ExecSeen {
	body?: Record<string, unknown>;
	requests: string[];
	control: string[];
	closed: number;
}

/**
 * A fake exec endpoint. The command is an operation that ends with `ret`
 * (or a wait that times out when `ret` is "timeout"). With websockets asked
 * for, stdout carries `stdout` and closes, or floods without end when
 * `stdout` is "flood", as a student's command can.
 */
function execServer(ret: number | "timeout", stdout: string, seen: ExecSeen) {
	const wss = new WebSocketServer({ noServer: true });
	const connected = new Map<string, WebSocket>();
	upgrade = (req, socket, head) => {
		const secret =
			new URL(req.url ?? "", "http://incus").searchParams.get("secret") ?? "";
		seen.requests.push(`WS ${secret}`);
		wss.handleUpgrade(req, socket, head, (ws) => {
			connected.set(secret, ws);
			ws.on("close", () => seen.closed++);
			if (secret === "sc") ws.on("message", (m) => seen.control.push(String(m)));
			if (connected.size < 4) return;
			const out = connected.get("s1");
			if (!out) return;
			if (stdout === "one big message") {
				out.send(Buffer.alloc(200 * 1024, "x"));
			} else if (stdout === "flood") {
				const chunk = Buffer.alloc(16 * 1024, "x");
				const pump = () => {
					if (out.readyState !== WebSocket.OPEN) return;
					out.send(chunk);
					setImmediate(pump);
				};
				pump();
			} else {
				out.send(Buffer.from(stdout));
				out.close();
			}
		});
	};
	return async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		seen.requests.push(`${req.method} ${req.url}`);
		const url = req.url ?? "";
		if (req.method === "POST" && url.startsWith("/1.0/instances/ws-a/exec")) {
			seen.body = JSON.parse(Buffer.concat(chunks).toString());
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/op1",
				metadata: {
					id: "op1",
					metadata: { fds: { "0": "s0", "1": "s1", "2": "s2", control: "sc" } },
				},
			});
		} else if (url.startsWith("/1.0/operations/op1/wait")) {
			respond(
				res,
				200,
				waitReply(
					ret === "timeout"
						? { status_code: 103 }
						: { status_code: 200, metadata: { return: ret } },
				),
			);
		} else {
			respond(res, 200, { type: "sync", status: "Success", status_code: 200 });
		}
	};
}

function execSeen(): ExecSeen {
	return { requests: [], control: [], closed: 0 };
}

test("exec runs a command and reports its exit status, with no output kept", async () => {
	const seen = execSeen();
	handler = execServer(3, "", seen);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const result = await client.exec("ws-a", ["true"], { timeoutSeconds: 5 });
	expect(result).toEqual({ status: 3, stdout: Buffer.alloc(0), tooLarge: false });
	expect(seen.body).toEqual({
		command: ["true"],
		"wait-for-websocket": false,
		"record-output": false,
		interactive: false,
	});
	expect(seen.requests).toEqual([
		"POST /1.0/instances/ws-a/exec?project=testproj",
		"GET /1.0/operations/op1/wait?timeout=5",
	]);
});

test("exec reads stdout over the exec websocket as the user given, never from a host log", async () => {
	const seen = execSeen();
	handler = execServer(0, "htop\n", seen);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const result = await client.exec("ws-a", ["cat", "x"], {
		timeoutSeconds: 5,
		user: 1000,
		outputMaxBytes: 100,
	});
	expect(result).toEqual({ status: 0, stdout: Buffer.from("htop\n"), tooLarge: false });
	expect(seen.body).toMatchObject({
		"wait-for-websocket": true,
		"record-output": false,
		user: 1000,
		group: 1000,
	});
	expect(seen.requests.filter((r) => r.startsWith("WS")).sort()).toEqual([
		"WS s0",
		"WS s1",
		"WS s2",
		"WS sc",
	]);
	expect(seen.requests.some((r) => r.includes("/logs/"))).toBe(false);
});

test("exec stops a flood of output at the limit: kills the command and closes every socket", async () => {
	const seen = execSeen();
	handler = execServer(0, "flood", seen);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const result = await client.exec("ws-a", ["cat", "x"], {
		timeoutSeconds: 5,
		outputMaxBytes: 64 * 1024,
	});
	expect(result).toEqual({ status: null, stdout: Buffer.alloc(0), tooLarge: true });
	await vi.waitFor(() => expect(seen.closed).toBe(4));
	expect(seen.control).toEqual([JSON.stringify({ command: "signal", signal: 9 })]);
	// Incus 7.5 refuses to cancel an exec, so nothing asks it to.
	expect(seen.requests.some((r) => r.startsWith("DELETE"))).toBe(false);
});

test("one stdout message over the limit takes the same kill path", async () => {
	const seen = execSeen();
	handler = execServer(0, "one big message", seen);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const result = await client.exec("ws-a", ["cat", "x"], {
		timeoutSeconds: 5,
		outputMaxBytes: 64 * 1024,
	});
	expect(result).toEqual({ status: null, stdout: Buffer.alloc(0), tooLarge: true });
	await vi.waitFor(() => expect(seen.closed).toBe(4));
	expect(seen.control).toEqual([JSON.stringify({ command: "signal", signal: 9 })]);
	// Incus 7.5 refuses to cancel an exec, so nothing asks it to.
	expect(seen.requests.some((r) => r.startsWith("DELETE"))).toBe(false);
});

test("an exec whose wait times out fails with TIMEOUT", async () => {
	const seen = execSeen();
	handler = execServer("timeout", "", seen);
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(
		client.exec("ws-a", ["sleep", "100"], { timeoutSeconds: 1 }),
	).rejects.toMatchObject({ code: "TIMEOUT" });
});

/**
 * A fake files API that behaves as Incus 7.5 does on a real host: a push
 * with "overwrite" and a GET open the path, which never returns for a named
 * pipe with no peer; HEAD reports the pipe as a regular file; DELETE only
 * looks at the path.
 */
function pipeAt(pipePath: string, log: string[]) {
	let pipe = pipePath;
	return (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url ?? "", "http://incus");
		const p = url.searchParams.get("path");
		log.push(`${req.method} ${p}`);
		req.resume();
		if (req.method === "HEAD") {
			res.writeHead(200, { "X-Incus-type": "file", "X-Incus-mode": "0644" });
			res.end();
			return;
		}
		if (p === pipe && (req.method === "POST" || req.method === "GET")) {
			return; // blocked opening the pipe
		}
		if (req.method === "DELETE" && p === pipe) pipe = "";
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
}

test("a plain push onto a named pipe hangs until the request times out", async () => {
	handler = pipeAt("/etc/hosts", []);
	const client = new IncusClient({ socketPath, project: "testproj" });
	await expect(
		client.pushFile(
			"ws-a",
			"/etc/hosts",
			"x",
			{ uid: 0, gid: 0, mode: "0644" },
			AbortSignal.timeout(200),
		),
	).rejects.toMatchObject({ code: "TIMEOUT" });
});

test("replaceFile deletes a named pipe, then writes with the owner and mode given", async () => {
	const log: string[] = [];
	handler = pipeAt("/etc/portikus/agent.token", log);
	const client = new IncusClient({ socketPath, project: "testproj" });
	await client.replaceFile(
		"ws-a",
		"/etc/portikus/agent.token",
		"t",
		{ uid: 1000, gid: 1000, mode: "0600" },
		AbortSignal.timeout(2000),
	);
	expect(log).toEqual([
		"DELETE /etc/portikus/agent.token",
		"POST /etc/portikus/agent.token",
	]);
});

test("replaceFile writes a missing file and refuses a path it cannot delete", async () => {
	const pushes: http.IncomingHttpHeaders[] = [];
	handler = (req, res) => {
		req.resume();
		if (req.method === "DELETE") {
			const missing = req.url?.includes("new");
			respond(res, missing ? 404 : 400, {
				type: "error",
				error: missing ? "not found" : "directory not empty",
				error_code: missing ? 404 : 400,
			});
			return;
		}
		pushes.push(req.headers);
		respond(res, 200, {
			type: "sync",
			status: "Success",
			status_code: 200,
			metadata: {},
		});
	};
	const client = new IncusClient({ socketPath, project: "testproj" });
	await client.replaceFile("ws-a", "/etc/new", "x", { uid: 0, gid: 0, mode: "0644" });
	expect(pushes).toHaveLength(1);
	expect(pushes[0]?.["x-incus-mode"]).toBe("0644");
	await expect(
		client.replaceFile("ws-a", "/etc/full", "x", { uid: 0, gid: 0, mode: "0644" }),
	).rejects.toThrow(/cannot be replaced/);
	expect(pushes).toHaveLength(1);
});

test("HEAD cannot tell a named pipe from a file, and the client has no read", async () => {
	const log: string[] = [];
	handler = pipeAt("/etc/hosts", log);
	const answer = await new Promise<http.IncomingMessage>((resolve) => {
		http
			.request(
				{
					socketPath,
					method: "HEAD",
					path: "/1.0/instances/ws-a/files?path=%2Fetc%2Fhosts",
				},
				resolve,
			)
			.end();
	});
	expect(answer.headers["x-incus-type"]).toBe("file");
	// The rule of SPEC.md §24 as code: nothing on the client GETs the files API.
	const client = new IncusClient({ socketPath, project: "testproj" });
	expect("readFile" in client).toBe(false);
});
