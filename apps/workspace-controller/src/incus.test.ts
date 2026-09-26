import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DEFAULT_REQUEST_TIMEOUT_MS, IncusClient, IncusError } from "./incus.js";

let socketPath: string;
let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incus-test-"));
	socketPath = path.join(dir, "test.sock");
	server = http.createServer((req, res) => handler(req, res));
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
			respond(res, 200, {
				type: "sync",
				status: "Success",
				status_code: 200,
				metadata: { done: true },
			});
		}
	};
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	const result = await client.request("POST", "/1.0/instances", {
		name: "test",
	});
	expect(result).toEqual({ done: true });
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
			respond(res, 200, {
				type: "sync",
				status: "Running",
				status_code: 103,
				metadata: {},
			});
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
				respond(res, 200, {
					type: "sync",
					status: "Success",
					status_code: 200,
					metadata: {},
				});
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
