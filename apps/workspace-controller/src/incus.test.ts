import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { IncusClient, IncusError } from "./incus.js";

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
