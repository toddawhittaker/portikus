import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { IncusClient } from "./incus.js";
import { IncusWorkspaceProvider } from "./provider.js";

let socketPath: string;
let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-test-"));
	socketPath = path.join(dir, "test.sock");
	server = http.createServer((req, res) => handler(req, res));
	await new Promise<void>((r) => server.listen(socketPath, r));
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve())),
	);
});

function respond(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
	});
}

function sync(metadata: unknown) {
	return {
		type: "sync",
		status: "Success",
		status_code: 200,
		metadata,
	};
}

let provider: IncusWorkspaceProvider;

beforeEach(() => {
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	provider = new IncusWorkspaceProvider({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
	});
});

test("create sends both disk devices in one POST and returns created", async () => {
	const requests: Array<{ method: string; url: string; body: string }> = [];
	handler = async (req, res) => {
		const body = await readBody(req);
		requests.push({
			method: req.method ?? "",
			url: req.url ?? "",
			body,
		});

		if (req.url?.includes("/volumes/custom")) {
			respond(res, 200, sync({}));
		} else if (req.url?.includes("/images/aliases/")) {
			respond(res, 200, sync({ target: "sha256abc" }));
		} else if (req.method === "POST" && req.url?.includes("/instances")) {
			respond(res, 200, sync({}));
		} else {
			respond(res, 200, sync({}));
		}
	};

	const result = await provider.create("ws-test", {
		homeGiB: 25,
		dockerGiB: 20,
	});
	expect(result.created).toBe(true);
	expect(result.imageFingerprint).toBe("sha256abc");

	// Find the POST /instances request.
	const instancePost = requests.find(
		(r) =>
			r.method === "POST" &&
			r.url?.includes("/1.0/instances") &&
			!r.url?.includes("/volumes"),
	);
	if (!instancePost) {
		throw new Error("expected a POST /instances request");
	}
	const parsed = JSON.parse(instancePost.body);
	expect(parsed.devices.home.path).toBe("/home/student");
	expect(parsed.devices.docker.path).toBe("/var/lib/docker");
});

test("create reuses existing volumes on 409", async () => {
	handler = async (req, res) => {
		await readBody(req);
		if (req.url?.includes("/volumes/custom") && req.method === "POST") {
			respond(res, 409, {
				type: "error",
				status: "Conflict",
				status_code: 409,
				error: "already exists",
			});
		} else if (req.url?.includes("/images/aliases/")) {
			respond(res, 200, sync({ target: "sha256abc" }));
		} else {
			respond(res, 200, sync({}));
		}
	};

	const result = await provider.create("ws-test", {
		homeGiB: 25,
		dockerGiB: 20,
	});
	expect(result.created).toBe(true);
});

test("start polls until inet address and returns ipv4", async () => {
	let pollCount = 0;
	handler = async (req, res) => {
		await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			respond(res, 200, sync({}));
		} else if (req.method === "GET" && req.url?.includes("/state")) {
			pollCount++;
			if (pollCount < 3) {
				respond(res, 200, sync({ status: "Running", network: {} }));
			} else {
				respond(
					res,
					200,
					sync({
						status: "Running",
						network: {
							eth0: {
								addresses: [
									{
										family: "inet",
										address: "10.0.0.5",
										scope: "global",
									},
								],
							},
						},
					}),
				);
			}
		} else {
			respond(res, 200, sync({}));
		}
	};

	const result = await provider.start("ws-test", {
		timeoutSeconds: 10,
	});
	expect(result.ipv4).toBe("10.0.0.5");
	expect(pollCount).toBeGreaterThanOrEqual(3);
});

test("start with no IP by deadline throws TIMEOUT", async () => {
	handler = async (req, res) => {
		await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			respond(res, 200, sync({}));
		} else if (req.method === "GET" && req.url?.includes("/state")) {
			respond(res, 200, sync({ status: "Running", network: {} }));
		} else {
			respond(res, 200, sync({}));
		}
	};

	await expect(provider.start("ws-test", { timeoutSeconds: 1 })).rejects.toMatchObject({
		code: "TIMEOUT",
	});
});

test("stop graceful success returns forced false", async () => {
	handler = async (req, res) => {
		await readBody(req);
		respond(res, 200, sync({}));
	};

	const result = await provider.stop("ws-test", {
		timeoutSeconds: 5,
	});
	expect(result.forced).toBe(false);
});

test("stop graceful failure retries with force true", async () => {
	let callCount = 0;
	handler = async (req, res) => {
		const _body = await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			callCount++;
			if (callCount === 1) {
				// Graceful stop fails.
				respond(res, 400, {
					type: "error",
					status: "Failure",
					status_code: 400,
					error: "stop failed",
				});
			} else {
				// Force stop succeeds.
				respond(res, 200, sync({}));
			}
		} else {
			respond(res, 200, sync({}));
		}
	};

	const result = await provider.stop("ws-test", {
		timeoutSeconds: 5,
	});
	expect(result.forced).toBe(true);
	expect(callCount).toBe(2);
});

test("list maps statuses correctly", async () => {
	handler = async (_req, res) => {
		respond(
			res,
			200,
			sync([
				{
					name: "ws-a",
					status: "Running",
					state: {
						network: {
							eth0: {
								addresses: [
									{
										family: "inet",
										address: "10.0.0.1",
										scope: "global",
									},
								],
							},
						},
					},
				},
				{ name: "ws-b", status: "Stopped", state: {} },
				{ name: "ws-c", status: "Freezing", state: {} },
			]),
		);
	};

	const result = await provider.list();
	expect(result).toEqual([
		{ name: "ws-a", status: "Running", ipv4: "10.0.0.1" },
		{ name: "ws-b", status: "Stopped", ipv4: null },
		{ name: "ws-c", status: "Other", ipv4: null },
	]);
});
