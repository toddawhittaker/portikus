import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { collectingLogger } from "@portikus/observability/testing";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { IncusClient } from "./incus.js";
import {
	AGENT_HEALTH_TIMEOUT_MS,
	INSTANCE_CREATE_WAIT_SECONDS,
	IncusWorkspaceProvider,
	InstanceNotStoppedError,
	SEED_BUILD_VOLUME,
	SEED_BUILDER,
	SEED_INFO_KEY,
	SEED_OLD_VOLUME,
	VOLUME_CREATE_TIMEOUT_MS,
	VolumeInUseError,
} from "./provider.js";

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
	// Incus sends an ETag on every instance read; the start's allowance check needs one.
	res.writeHead(status, { "Content-Type": "application/json", ETag: '"e1"' });
	res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
	});
}

function runningWithAddress(address: string) {
	return {
		status: "Running",
		network: {
			eth0: {
				addresses: [{ family: "inet", address, scope: "global" }],
			},
		},
	};
}

function sync(metadata: unknown) {
	return {
		type: "sync",
		status: "Success",
		status_code: 200,
		metadata,
	};
}

const AGENT_TOKEN = "a".repeat(64);

// A stand-in workspace agent on loopback. The fake Incus reports 127.0.0.1
// as the instance address, so the provider dials this server.
let agent: http.Server;
let agentPort: number;
let agentRequests: number;
let agentToken: string;

beforeAll(async () => {
	agentToken = AGENT_TOKEN;
	agentRequests = 0;
	agent = http.createServer((req, res) => {
		agentRequests++;
		if (req.headers.authorization === `Bearer ${agentToken}`) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
		} else {
			res.writeHead(401);
			res.end();
		}
	});
	await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
	agentPort = (agent.address() as { port: number }).port;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		agent.close((err) => (err ? reject(err) : resolve())),
	);
});

afterEach(() => {
	agentToken = AGENT_TOKEN;
});

let provider: IncusWorkspaceProvider;
let statusPath: string;

beforeEach(() => {
	statusPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thinpool-")), "s.json");
	const client = new IncusClient({
		socketPath,
		project: "testproj",
	});
	provider = new IncusWorkspaceProvider({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort,
		thinPoolStatusPath: statusPath,
	});
});

/** A fake Incus whose pool is `used` of 100 bytes full; records every request. */
function poolAt(used: number, requests: string[]) {
	return async (req: http.IncomingMessage, res: http.ServerResponse) => {
		await readBody(req);
		requests.push(`${req.method} ${req.url}`);
		if (req.method === "GET" && req.url?.startsWith("/1.0/instances/")) {
			respond(res, 404, {
				type: "error",
				status_code: 404,
				error: "Instance not found",
			});
		} else if (req.url?.includes("/storage-pools/mypool/resources")) {
			respond(res, 200, sync({ space: { used, total: 100 } }));
		} else if (req.url?.includes("/images/aliases/")) {
			respond(res, 200, sync({ target: "sha256abc" }));
		} else {
			respond(res, 200, sync({}));
		}
	};
}

const SIZES = { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 };

test("create is refused with POOL_FULL at 90% data use, before any volume is made", async () => {
	const requests: string[] = [];
	handler = poolAt(90, requests);
	await expect(provider.create("ws-test", SIZES)).rejects.toMatchObject({
		code: "POOL_FULL",
	});
	expect(requests).toEqual([
		"GET /1.0/instances/ws-test?project=testproj",
		"GET /1.0/storage-pools/mypool/resources?project=testproj",
	]);
});

test("a full pool does not refuse adopting an instance that already exists", async () => {
	const requests: string[] = [];
	const full = poolAt(95, requests);
	handler = async (req, res) => {
		if (req.method === "GET" && req.url?.startsWith("/1.0/instances/ws-test")) {
			await readBody(req);
			respond(res, 200, sync({ name: "ws-test", status: "Stopped" }));
		} else if (req.method === "POST" && req.url?.startsWith("/1.0/instances?")) {
			await readBody(req);
			respond(res, 409, { type: "error", status_code: 409, error: "already exists" });
		} else {
			await full(req, res);
		}
	};
	expect((await provider.create("ws-test", SIZES)).created).toBe(false);
	expect(requests.some((r) => r.includes("/resources"))).toBe(false);
});

test("the instance create waits long enough for a slow first create, inside the worker's 300 s", async () => {
	expect(INSTANCE_CREATE_WAIT_SECONDS).toBeGreaterThan(60);
	expect(INSTANCE_CREATE_WAIT_SECONDS).toBeLessThan(300);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const spy = vi.spyOn(client, "request");
	const own = new IncusWorkspaceProvider({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort,
		thinPoolStatusPath: statusPath,
	});
	handler = poolAt(10, []);
	await own.create("ws-test", SIZES);
	const create = spy.mock.calls.find(
		(c) => c[0] === "POST" && c[1] === "/1.0/instances",
	);
	expect(create?.[4]).toBe(INSTANCE_CREATE_WAIT_SECONDS);
});

test("volume creates get their own longer bound than the 30 s default", async () => {
	expect(VOLUME_CREATE_TIMEOUT_MS).toBeGreaterThan(30_000);
	const client = new IncusClient({ socketPath, project: "testproj" });
	const spy = vi.spyOn(client, "request");
	const own = new IncusWorkspaceProvider({
		client,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort,
		thinPoolStatusPath: statusPath,
	});
	handler = poolAt(10, []);
	await own.create("ws-test", SIZES);
	const volumeCalls = spy.mock.calls.filter(
		(c) => c[0] === "POST" && String(c[1]).includes("/volumes/custom"),
	);
	expect(volumeCalls).toHaveLength(3);
	for (const call of volumeCalls) expect(call[5]).toBe(VOLUME_CREATE_TIMEOUT_MS);
});

test("create is refused when metadata use reaches 90%, even with data room", async () => {
	fs.writeFileSync(
		statusPath,
		JSON.stringify({
			observedAt: new Date().toISOString(),
			dataPercent: 10,
			metadataPercent: 90.5,
		}),
	);
	handler = poolAt(10, []);
	await expect(provider.create("ws-test", SIZES)).rejects.toMatchObject({
		code: "POOL_FULL",
	});
});

test("create goes ahead just under 90%", async () => {
	handler = poolAt(89, []);
	expect((await provider.create("ws-test", SIZES)).created).toBe(true);
});

/** poolAt, plus a seed of `seedBytes` (or none when null) and no Docker volume yet. */
function seededPoolAt(used: number, seedBytes: number | null) {
	const base = poolAt(used, []);
	return async (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (
			req.method === "GET" &&
			req.url?.includes("/volumes/custom/portikus-docker-seed?")
		) {
			await readBody(req);
			const config =
				seedBytes === null
					? {}
					: {
							[SEED_INFO_KEY]: JSON.stringify({
								images: ["alpine:3"],
								sizeBytes: seedBytes,
								imageVersion: "2026.09.15",
								builtAt: "2026-09-30T00:00:00.000Z",
							}),
						};
			respond(res, 200, sync({ config }));
		} else if (
			req.method === "GET" &&
			req.url?.includes("/volumes/custom/ws-test-docker?")
		) {
			await readBody(req);
			respond(res, 404, { type: "error", status_code: 404, error: "not found" });
		} else {
			await base(req, res);
		}
	};
}

describe("create counts the Docker seed it will copy (SPEC.md 24.5, SEC1)", () => {
	test("refused when the seed tips the pool to 90%", async () => {
		handler = seededPoolAt(80, 10);
		await expect(provider.create("ws-test", SIZES)).rejects.toMatchObject({
			code: "POOL_FULL",
			message: expect.stringContaining("90% full"),
		});
	});

	test("admitted when the pool plus the seed stays below 90%", async () => {
		handler = seededPoolAt(80, 9);
		expect((await provider.create("ws-test", SIZES)).created).toBe(true);
	});

	test("admitted with no seed", async () => {
		handler = seededPoolAt(89, null);
		expect((await provider.create("ws-test", SIZES)).created).toBe(true);
	});

	test("admitted when the seed's size cannot be read", async () => {
		const base = seededPoolAt(89, 50);
		handler = async (req, res) => {
			if (
				req.method === "GET" &&
				req.url?.includes("/volumes/custom/portikus-docker-seed?")
			) {
				await readBody(req);
				respond(res, 500, { type: "error", status_code: 500, error: "boom" });
			} else {
				await base(req, res);
			}
		};
		expect((await provider.create("ws-test", SIZES)).created).toBe(true);
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
		recoveryGiB: 3,
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
	// The recovery volume is its own storage class (ADR 0020).
	expect(parsed.devices.recovery).toEqual({
		type: "disk",
		pool: "mypool",
		source: "ws-test-recovery",
		path: "/var/lib/portikus/recovery",
	});
	const volumes = requests
		.filter((r) => r.method === "POST" && r.url.includes("/volumes/custom"))
		.map((r) => JSON.parse(r.body));
	expect(volumes).toEqual([
		{ name: "ws-test-home", config: { size: "25GiB" } },
		{ name: "ws-test-docker", config: { size: "20GiB" } },
		{ name: "ws-test-recovery", config: { size: "3GiB" } },
	]);
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
		recoveryGiB: 3,
	});
	expect(result.created).toBe(true);
});

test("start pushes the agent token, then waits for agent health", async () => {
	let pollCount = 0;
	const pushes: Array<{
		url: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	}> = [];
	let agentRequestsAtPush = -1;
	const execs: string[] = [];
	handler = async (req, res) => {
		const body = await readBody(req);
		if (req.url?.includes("/exec")) {
			execs.push(body);
			respond(res, 200, sync({}));
		} else if (req.url?.includes("/files")) {
			pushes.push({ url: req.url, headers: req.headers, body });
			agentRequestsAtPush = agentRequests;
			respond(res, 200, sync({}));
		} else if (req.method === "PUT" && req.url?.includes("/state")) {
			respond(res, 200, sync({}));
		} else if (req.method === "GET" && req.url?.includes("/state")) {
			pollCount++;
			if (pollCount < 3) {
				respond(res, 200, sync({ status: "Running", network: {} }));
			} else {
				respond(res, 200, sync(runningWithAddress("127.0.0.1")));
			}
		} else {
			respond(res, 200, sync({}));
		}
	};

	const before = agentRequests;
	const result = await provider.start("ws-test", {
		timeoutSeconds: 10,
		agentToken: AGENT_TOKEN,
		hostname: "tw7",
		previewHostSuffix: "preview.portikus.example.edu",
		timezone: "America/New_York",
	});

	expect(result.ipv4).toBe("127.0.0.1");
	expect(pollCount).toBeGreaterThanOrEqual(3);
	// The hostname lands first, then the timezone, then the shell profile,
	// then the agent token.
	expect(pushes).toHaveLength(4);
	const hostnamePush = pushes[0];
	const timezonePush = pushes[1];
	const profilePush = pushes[2];
	const push = pushes[3];
	if (!hostnamePush || !timezonePush || !profilePush || !push) {
		throw new Error("expected four file pushes");
	}
	expect(hostnamePush.url).toContain("path=%2Fetc%2Fhostname");
	expect(hostnamePush.body).toBe("tw7\n");
	expect(hostnamePush.headers["x-incus-uid"]).toBe("0");
	// Every login shell reads this, so a terminal sees the preview suffix
	// (issue #263). It is owned by root, world readable, and has no secret.
	// The container runs in the owner's zone from this start on (issue #287):
	// /etc/timezone for the tools that read it, /etc/localtime for libc.
	expect(timezonePush.url).toContain("path=%2Fetc%2Ftimezone");
	expect(timezonePush.body).toBe("America/New_York\n");
	expect(timezonePush.headers["x-incus-uid"]).toBe("0");
	expect(timezonePush.headers["x-incus-mode"]).toBe("0644");
	expect(execs.some((body) => body.includes("hostname"))).toBe(true);
	const localtime = execs.find((body) => body.includes("localtime"));
	if (!localtime) throw new Error("expected an exec linking /etc/localtime");
	expect(JSON.parse(localtime).command).toEqual([
		"ln",
		"-sfn",
		"/usr/share/zoneinfo/America/New_York",
		"/etc/localtime",
	]);
	expect(profilePush.url).toContain("path=%2Fetc%2Fprofile.d%2Fportikus.sh");
	expect(profilePush.body).toBe(
		"export PORTIKUS_PREVIEW=true\nexport PORTIKUS_PREVIEW_HOST_SUFFIX=preview.portikus.example.edu\n" +
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a placeholder
			'export TZ="${TZ:-America/New_York}"\n',
	);
	expect(profilePush.headers["x-incus-uid"]).toBe("0");
	expect(profilePush.headers["x-incus-gid"]).toBe("0");
	expect(profilePush.headers["x-incus-mode"]).toBe("0644");
	expect(profilePush.body).not.toContain(AGENT_TOKEN);
	expect(push.url).toContain("path=%2Fetc%2Fportikus%2Fagent.token");
	expect(push.headers["x-incus-uid"]).toBe("1000");
	expect(push.headers["x-incus-mode"]).toBe("0600");
	expect(push.body).toBe(AGENT_TOKEN);
	// The token file lands before the first health request.
	expect(agentRequestsAtPush).toBe(before);
	expect(agentRequests).toBeGreaterThan(before);
});

/**
 * Issue #287: the zone is set by linking a file from the image. If the image
 * has no such file the link fails, and the container would come up in the
 * wrong zone with nothing said. The start must fail instead.
 */
test("start fails when the image has no file for the chosen zone", async () => {
	handler = async (req, res) => {
		await readBody(req);
		if (req.url?.includes("/operations/exec-1/wait")) {
			respond(res, 200, sync({ status_code: 200, metadata: { return: 1 } }));
		} else if (req.url?.includes("/exec")) {
			// Incus runs an exec as an operation and reports the exit status.
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/exec-1",
			});
		} else if (req.url?.includes("/files")) {
			respond(res, 200, sync({}));
		} else if (req.method === "GET" && req.url?.includes("/state")) {
			respond(res, 200, sync(runningWithAddress("127.0.0.1")));
		} else {
			respond(res, 200, sync({}));
		}
	};

	await expect(
		provider.start("ws-test", {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.portikus.example.edu",
			timezone: "America/New_York",
		}),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
		message: expect.stringContaining("America/New_York"),
	});
});

test("start refuses a hostname that is not a DNS label", async () => {
	handler = async (req, res) => {
		await readBody(req);
		respond(res, 200, sync({}));
	};

	await expect(
		provider.start("ws-test", {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7; rm -rf /",
			previewHostSuffix: "preview.portikus.example.edu",
			timezone: "America/New_York",
		}),
	).rejects.toMatchObject({ code: "INVALID_NAME" });
});

test(
	"the agent health wait has its own budget, not the whole start timeout",
	async () => {
		// The agent only honours a different token, so /health stays 401.
		agentToken = "b".repeat(64);
		handler = async (req, res) => {
			await readBody(req);
			if (req.url?.includes("/files")) {
				respond(res, 200, sync({}));
			} else if (req.method === "PUT" && req.url?.includes("/state")) {
				respond(res, 200, sync({}));
			} else if (req.method === "GET" && req.url?.includes("/state")) {
				respond(res, 200, sync(runningWithAddress("127.0.0.1")));
			} else {
				respond(res, 200, sync({}));
			}
		};

		const started = Date.now();
		// A generous start timeout: the health wait must still give up on its
		// own budget, so one broken agent cannot block the worker's start loop.
		await expect(
			provider.start("ws-test", {
				timeoutSeconds: 120,
				agentToken: AGENT_TOKEN,
				hostname: "tw7",
				previewHostSuffix: "preview.portikus.example.edu",
				timezone: "America/New_York",
			}),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(AGENT_HEALTH_TIMEOUT_MS - 1000);
		expect(elapsed).toBeLessThan(AGENT_HEALTH_TIMEOUT_MS + 10_000);
	},
	AGENT_HEALTH_TIMEOUT_MS + 15_000,
);

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

	await expect(
		provider.start("ws-test", {
			timeoutSeconds: 1,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.portikus.example.edu",
			timezone: "America/New_York",
		}),
	).rejects.toMatchObject({
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

// Incus answers the wait with a success reply even when the graceful stop
// failed or is still running; the forced stop must follow all the same.
for (const [outcome, operation] of [
	[
		"fails",
		{
			status_code: 400,
			status: "Failure",
			err: 'Failed shutting down instance, status is "Running": context deadline exceeded',
		},
	],
	["is still running", { status_code: 103, status: "Running", err: "" }],
] as const) {
	test(`a graceful stop whose operation ${outcome} is retried with force`, async () => {
		const puts: Array<{ force?: boolean }> = [];
		handler = async (req, res) => {
			const body = await readBody(req);
			if (req.method === "PUT" && req.url?.includes("/state")) {
				puts.push(JSON.parse(body));
				respond(res, 202, {
					type: "async",
					status: "Operation created",
					status_code: 100,
					operation: `/1.0/operations/stop-${puts.length}`,
				});
			} else if (req.url?.includes("/operations/stop-1/wait")) {
				respond(res, 200, sync(operation));
			} else if (req.url?.includes("/operations/stop-2/wait")) {
				respond(res, 200, sync({ status_code: 200, status: "Success", err: "" }));
			} else {
				respond(res, 200, sync({ status: "Running" }));
			}
		};

		const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
		expect(result.forced).toBe(true);
		expect(puts.map((p) => p.force)).toEqual([false, true]);
	});
}

/** A fake Incus for stop: both stop PUTs fail inside their operation; the state read reports `after`. */
function stopsFail(after: string, puts: Array<{ force?: boolean }>) {
	return async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const body = await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			puts.push(JSON.parse(body));
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: `/1.0/operations/stop-${puts.length}`,
			});
		} else if (req.url?.includes("/wait")) {
			respond(
				res,
				200,
				sync({ status_code: 400, status: "Failure", err: "stop failed" }),
			);
		} else {
			// The first read is stop()'s own check; later ones follow the failed stops.
			respond(res, 200, sync({ status: puts.length === 0 ? "Running" : after }));
		}
	};
}

test("a forced stop that fails because the graceful stop just finished still reports stopped", async () => {
	const puts: Array<{ force?: boolean }> = [];
	handler = stopsFail("Stopped", puts);
	const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
	expect(result.forced).toBe(true);
	expect(puts.map((p) => p.force)).toEqual([false, true]);
});

// Issue #704: a stop that meets an instance already shutting down fails in
// Incus with "Invalid PID -1"; the instance reads Stopping, then Stopped.
test("a stop that races an instance already shutting down reports stopped", async () => {
	const puts: Array<{ force?: boolean }> = [];
	let readsAfter = 0;
	handler = async (req, res) => {
		const body = await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			puts.push(JSON.parse(body));
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: `/1.0/operations/stop-${puts.length}`,
			});
		} else if (req.url?.includes("/wait")) {
			respond(
				res,
				200,
				sync({ status_code: 400, status: "Failure", err: "Invalid PID -1" }),
			);
		} else if (puts.length === 0) {
			respond(res, 200, sync({ status: "Running" }));
		} else {
			readsAfter++;
			respond(res, 200, sync({ status: readsAfter < 3 ? "Stopping" : "Stopped" }));
		}
	};
	const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
	expect(result.forced).toBe(true);
	expect(puts.map((p) => p.force)).toEqual([false, true]);
});

test("a forced stop that fails while the instance still runs is an error", async () => {
	handler = stopsFail("Running", []);
	await expect(provider.stop("ws-test", { timeoutSeconds: 1 })).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
});

test("stop on an already-stopped instance is a no-op", async () => {
	let puts = 0;
	handler = async (req, res) => {
		await readBody(req);
		if (req.method === "PUT") {
			puts++;
			respond(res, 200, sync({}));
			return;
		}
		respond(res, 200, sync({ status: "Stopped" }));
	};

	const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
	expect(result.forced).toBe(false);
	expect(puts).toBe(0);
});

// Issue #704, as seen on the rehearsal VM: for about a second of a shutdown
// Incus answers the state read itself with 500 "Invalid PID -1".
test("a stop whose first state read fails with Invalid PID -1 reports stopped", async () => {
	const puts: Array<{ force?: boolean }> = [];
	let reads = 0;
	handler = async (req, res) => {
		const body = await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			puts.push(JSON.parse(body));
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: `/1.0/operations/stop-${puts.length}`,
			});
		} else if (req.url?.includes("/wait")) {
			respond(
				res,
				200,
				sync({ status_code: 400, status: "Failure", err: "Invalid PID -1" }),
			);
		} else if (++reads < 3) {
			respond(res, 500, {
				type: "error",
				status: "",
				status_code: 0,
				error_code: 500,
				error: "Invalid PID -1",
			});
		} else {
			respond(res, 200, sync({ status: "Stopped" }));
		}
	};
	const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
	expect(result.forced).toBe(true);
});

test("a normal stop after one failed state read is not forced", async () => {
	const puts: Array<{ force?: boolean }> = [];
	let reads = 0;
	handler = async (req, res) => {
		const body = await readBody(req);
		if (req.method === "PUT" && req.url?.includes("/state")) {
			puts.push(JSON.parse(body));
			respond(res, 202, {
				type: "async",
				status: "Operation created",
				status_code: 100,
				operation: "/1.0/operations/stop-1",
			});
		} else if (req.url?.includes("/wait")) {
			respond(res, 200, sync({ status_code: 200, status: "Success" }));
		} else if (++reads === 1) {
			respond(res, 500, { type: "error", error_code: 500, error: "Invalid PID -1" });
		} else {
			respond(res, 200, sync({ status: "Stopped" }));
		}
	};
	const result = await provider.stop("ws-test", { timeoutSeconds: 5 });
	expect(result.forced).toBe(false);
	expect(puts).toEqual([expect.objectContaining({ force: false })]);
});

for (const code of [403, 500]) {
	test(`a stop still rejects when every state read answers ${code}`, async () => {
		handler = async (req, res) => {
			await readBody(req);
			if (req.method === "PUT" && req.url?.includes("/state")) {
				respond(res, 202, {
					type: "async",
					status: "Operation created",
					status_code: 100,
					operation: "/1.0/operations/stop-1",
				});
			} else if (req.url?.includes("/wait")) {
				respond(res, 200, sync({ status_code: 400, status: "Failure", err: "boom" }));
			} else {
				respond(res, code, { type: "error", error_code: code, error: "nope" });
			}
		};
		await expect(provider.stop("ws-test", { timeoutSeconds: 1 })).rejects.toBeDefined();
	});
}

test("stop on a missing instance still reports NOT_FOUND", async () => {
	let puts = 0;
	handler = async (req, res) => {
		await readBody(req);
		if (req.method === "PUT") puts++;
		respond(res, 404, { type: "error", status_code: 404, error: "Instance not found" });
	};
	await expect(provider.stop("ws-test", { timeoutSeconds: 5 })).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	expect(puts).toBe(0);
});

test("a missing image alias reports IMAGE_NOT_FOUND", async () => {
	handler = async (req, res) => {
		await readBody(req);
		if (req.url?.includes("/images/aliases/")) {
			respond(res, 404, {
				type: "error",
				status: "Failure",
				status_code: 404,
				error: "not found",
			});
			return;
		}
		respond(res, 200, sync({}));
	};

	await expect(
		provider.create("ws-test", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 }),
	).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
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

test("start refuses a preview host suffix that is not a DNS name", async () => {
	handler = async (req, res) => {
		await readBody(req);
		respond(res, 200, sync({}));
	};

	await expect(
		provider.start("ws-test", {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu\nexport EVIL=1",
			timezone: "America/New_York",
		}),
	).rejects.toMatchObject({ code: "INVALID_NAME" });
});

/**
 * Issue #287: the zone name becomes part of a path in a command inside the
 * container, so only a name on the zone list may get that far.
 */
test("start refuses a timezone that is not a known zone", async () => {
	handler = async (req, res) => {
		await readBody(req);
		respond(res, 200, sync({}));
	};

	for (const bad of ["Mars/Olympus", "../../etc/shadow", "America/New_York; id"]) {
		await expect(
			provider.start("ws-test", {
				timeoutSeconds: 10,
				agentToken: AGENT_TOKEN,
				hostname: "tw7",
				previewHostSuffix: "preview.portikus.example.edu",
				timezone: bad,
			}),
		).rejects.toMatchObject({ code: "INVALID_NAME" });
	}
});

// Recovery volume, Reset Docker and Rebuild (Epic 10, ADR 0020, ADR 0021).
// A small stateful Incus: one instance, the pool's custom volumes, an ETag
// that changes on every write, and PATCH that merges devices as Incus does.

interface FakeIncus {
	status: string;
	devices: Record<string, Record<string, string>>;
	config: Record<string, string>;
	etagSeq: number;
	volumes: Map<string, string>;
	deleted: string[];
	createdVolumes: string[];
	puts: Array<{ ifMatch: string | undefined; body: Record<string, unknown> }>;
	patches: Array<Record<string, unknown>>;
	rebuilds: unknown[];
	execs: string[][];
	/** Fail the next volume create with a server error, once. */
	failVolumeCreate: boolean;
	/** Answer the next PUT with 412, as Incus does for a stale ETag. */
	staleEtag: boolean;
	/** Every volume create body, in order. */
	volumeBodies: Array<Record<string, unknown>>;
	/** Custom volume config, by volume name. */
	volumeConfigs: Map<string, Record<string, string>>;
	/** Fail a volume create that copies from another volume. */
	failCopy: boolean;
	/** The container's files as the files API shows them. */
	files: Map<string, { type: string; content: string }>;
	/** Files API writes and deletes, in order, as "POST path" or "DELETE path". */
	fileOps: string[];
	/** Rewrite /etc/hosts at the next start, as the image's create/copy template does. */
	hostsTemplate: string | null;
	/** Every request, as "METHOD path", in order. */
	log: string[];
	instanceCreates: Array<{ devices: Record<string, Record<string, string>> }>;
}

function disk(source: string, diskPath: string): Record<string, string> {
	return { type: "disk", pool: "mypool", source, path: diskPath };
}

function fakeIncus(): FakeIncus {
	return {
		status: "Stopped",
		devices: {
			home: disk("ws-test-home", "/home/student"),
			docker: disk("ws-test-docker", "/var/lib/docker"),
			recovery: disk("ws-test-recovery", "/var/lib/portikus/recovery"),
		},
		config: { "volatile.base_image": "old", "image.os": "debian" },
		etagSeq: 1,
		volumes: new Map([
			["ws-test-home", "25GiB"],
			["ws-test-docker", "20GiB"],
			["ws-test-recovery", "3GiB"],
		]),
		deleted: [],
		createdVolumes: [],
		puts: [],
		patches: [],
		rebuilds: [],
		execs: [],
		failVolumeCreate: false,
		staleEtag: false,
		volumeBodies: [],
		volumeConfigs: new Map(),
		failCopy: false,
		files: new Map([
			["/etc/docker", { type: "directory", content: "" }],
			[
				"/etc/docker/daemon.json",
				{
					type: "file",
					content:
						'{"storage-driver":"overlay2","features":{"containerd-snapshotter":false}}',
				},
			],
			["/etc/hosts", { type: "file", content: "127.0.0.1 localhost\n" }],
		]),
		fileOps: [],
		hostsTemplate: null,
		log: [],
		instanceCreates: [],
	};
}

function incusError(res: http.ServerResponse, code: number, error: string): void {
	respond(res, code, {
		type: "error",
		status: "Failure",
		status_code: code,
		error,
		error_code: code,
	});
}

function serveIncus(state: FakeIncus): void {
	handler = async (req, res) => {
		const body = await readBody(req);
		const url = new URL(req.url ?? "/", "http://incus");
		const p = url.pathname;
		const method = req.method ?? "";
		const etag = `"e${state.etagSeq}"`;
		const volumePrefix = "/1.0/storage-pools/mypool/volumes/custom";
		state.log.push(`${method} ${p}`);

		if (p === "/1.0/instances/ws-test" && method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
			res.end(
				JSON.stringify(
					sync({
						name: "ws-test",
						status: state.status,
						architecture: "x86_64",
						config: state.config,
						devices: state.devices,
						ephemeral: false,
						profiles: ["workspace"],
						stateful: false,
						description: "",
					}),
				),
			);
		} else if (p === "/1.0/instances/ws-test" && method === "PUT") {
			const parsed = JSON.parse(body);
			state.puts.push({
				ifMatch: req.headers["if-match"] as string | undefined,
				body: parsed,
			});
			if (state.staleEtag || req.headers["if-match"] !== etag) {
				state.staleEtag = false;
				incusError(res, 412, "ETag doesn't match");
				return;
			}
			state.devices = parsed.devices;
			state.config = parsed.config;
			state.etagSeq++;
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances/ws-test" && method === "PATCH") {
			const parsed = JSON.parse(body);
			state.patches.push(parsed);
			state.devices = { ...state.devices, ...parsed.devices };
			state.etagSeq++;
			respond(res, 200, sync({}));
		} else if (p === volumePrefix && method === "POST") {
			const parsed = JSON.parse(body);
			if (state.failVolumeCreate) {
				state.failVolumeCreate = false;
				incusError(res, 500, "lvcreate failed");
				return;
			}
			state.volumeBodies.push(parsed);
			if (state.volumes.has(parsed.name)) {
				incusError(res, 409, "Volume by that name already exists");
				return;
			}
			if (parsed.source && state.failCopy) {
				incusError(res, 500, "copy failed");
				return;
			}
			state.createdVolumes.push(parsed.name);
			state.volumes.set(parsed.name, parsed.config.size);
			state.volumeConfigs.set(parsed.name, parsed.config);
			respond(res, 200, sync({}));
		} else if (p.startsWith(`${volumePrefix}/`) && method === "GET") {
			const name = decodeURIComponent(p.slice(volumePrefix.length + 1));
			if (!state.volumes.has(name)) {
				incusError(res, 404, "Storage volume not found");
				return;
			}
			respond(
				res,
				200,
				sync({ name, config: state.volumeConfigs.get(name) ?? {}, used_by: [] }),
			);
		} else if (p === "/1.0/instances/ws-test/files") {
			const path = url.searchParams.get("path") ?? "";
			if (method === "GET") {
				const file = state.files.get(path);
				if (!file) {
					incusError(res, 404, "not found");
					return;
				}
				res.writeHead(200, { "X-Incus-type": file.type });
				res.end(file.content);
				return;
			}
			state.fileOps.push(`${method} ${path}`);
			if (method === "DELETE" && !state.files.delete(path)) {
				incusError(res, 404, "not found");
				return;
			}
			if (method === "POST") {
				const type = String(req.headers["x-incus-type"] ?? "file");
				const existing = state.files.get(path);
				if (type === "directory" && existing && existing.type !== "directory") {
					incusError(res, 400, "not a directory");
					return;
				}
				state.files.set(path, { type, content: body });
			}
			respond(res, 200, sync({}));
		} else if (p.startsWith(`${volumePrefix}/`) && method === "DELETE") {
			const name = decodeURIComponent(p.slice(volumePrefix.length + 1));
			if (!state.volumes.has(name)) {
				incusError(res, 404, "Storage volume not found");
				return;
			}
			if (Object.values(state.devices).some((d) => d.source === name)) {
				incusError(res, 400, "The storage volume is still in use");
				return;
			}
			state.deleted.push(name);
			state.volumes.delete(name);
			respond(res, 200, sync({}));
		} else if (p === "/1.0/images/aliases/portikus") {
			respond(res, 200, sync({ target: "newfingerprint" }));
		} else if (p === "/1.0/instances/ws-test/rebuild" && method === "POST") {
			if (state.status !== "Stopped") {
				incusError(res, 400, "Instance must be stopped to be rebuilt");
				return;
			}
			state.rebuilds.push(JSON.parse(body));
			state.config = { ...state.config, "volatile.base_image": "newfingerprint" };
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances/ws-test/state" && method === "PUT") {
			state.status = "Running";
			if (state.hostsTemplate !== null) {
				state.files.set("/etc/hosts", { type: "file", content: state.hostsTemplate });
				state.hostsTemplate = null;
			}
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances/ws-test/state" && method === "GET") {
			respond(res, 200, sync(runningWithAddress("127.0.0.1")));
		} else if (p === "/1.0/instances/ws-test/exec") {
			state.execs.push(JSON.parse(body).command);
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances" && method === "POST") {
			state.instanceCreates.push(JSON.parse(body));
			respond(res, 200, sync({}));
		} else {
			incusError(res, 404, `unexpected ${method} ${p}`);
		}
	};
}

const START = {
	timeoutSeconds: 10,
	agentToken: AGENT_TOKEN,
	hostname: "tw7",
	previewHostSuffix: "preview.portikus.example.edu",
	timezone: "America/New_York",
};

test("reset Docker puts back every other device exactly and replaces only the docker volume", async () => {
	const state = fakeIncus();
	serveIncus(state);
	const before = structuredClone(state.devices);
	const configBefore = structuredClone(state.config);

	await provider.resetDocker("ws-test", { dockerGiB: 30 });

	// The one PUT carries the ETag it read and every device but docker, as read.
	expect(state.puts).toHaveLength(1);
	const put = state.puts[0];
	if (!put) throw new Error("expected a PUT");
	expect(put.ifMatch).toBe('"e1"');
	expect(put.body.devices).toEqual({ home: before.home, recovery: before.recovery });
	expect(put.body.config).toEqual(configBefore);
	expect(put.body.profiles).toEqual(["workspace"]);

	expect(state.devices.home).toEqual(before.home);
	expect(state.devices.recovery).toEqual(before.recovery);
	expect(state.devices.docker).toEqual(before.docker);
	expect(state.deleted).toEqual(["ws-test-docker"]);
	expect(state.createdVolumes).toEqual(["ws-test-docker"]);
	// A new volume picks up the current quota (docs/archive/epics/EPIC-10.md risk 9).
	expect(state.volumes.get("ws-test-docker")).toBe("30GiB");
	expect(state.volumes.get("ws-test-home")).toBe("25GiB");
	expect(state.volumes.get("ws-test-recovery")).toBe("3GiB");
});

test("reset Docker refuses a running instance and changes nothing", async () => {
	const state = fakeIncus();
	state.status = "Running";
	serveIncus(state);

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toBeInstanceOf(InstanceNotStoppedError);
	expect(state.puts).toHaveLength(0);
	expect(state.deleted).toHaveLength(0);
});

test("reset Docker aborts when the home device is missing from what it read", async () => {
	const state = fakeIncus();
	const { home: _home, ...rest } = state.devices;
	state.devices = rest;
	serveIncus(state);

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
		message: expect.stringContaining("home"),
	});
	expect(state.puts).toHaveLength(0);
	expect(state.deleted).toHaveLength(0);
	expect(state.createdVolumes).toHaveLength(0);
});

test("reset Docker never deletes a volume the docker device does not name exactly", async () => {
	const state = fakeIncus();
	// Someone pointed the docker device at the home volume.
	state.devices.docker = disk("ws-test-home", "/var/lib/docker");
	serveIncus(state);

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
	expect(state.puts).toHaveLength(0);
	expect(state.deleted).toHaveLength(0);
	expect(state.volumes.has("ws-test-home")).toBe(true);
});

test("a stale ETag stops the reset before any volume is deleted", async () => {
	const state = fakeIncus();
	state.staleEtag = true;
	serveIncus(state);

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
	expect(state.deleted).toHaveLength(0);
	expect(Object.keys(state.devices).sort()).toEqual(["docker", "home", "recovery"]);
});

test("a reset interrupted after the delete finishes when retried", async () => {
	const state = fakeIncus();
	const before = structuredClone(state.devices);
	state.failVolumeCreate = true;
	serveIncus(state);

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
	// Half done: device off, old volume gone, no new one yet.
	expect(state.devices.docker).toBeUndefined();
	expect(state.volumes.has("ws-test-docker")).toBe(false);

	await provider.resetDocker("ws-test", { dockerGiB: 20 });

	expect(state.devices).toEqual(before);
	expect(state.volumes.get("ws-test-docker")).toBe("20GiB");
	// The retry does not PUT again, since there is no device to take off.
	expect(state.puts).toHaveLength(1);
	expect(state.deleted).toEqual(["ws-test-docker"]);
});

test("a reset interrupted after the new volume was made finishes when retried", async () => {
	const state = fakeIncus();
	const before = structuredClone(state.devices);
	serveIncus(state);
	const original = handler;
	let failPatch = true;
	handler = async (req, res) => {
		if (failPatch && req.method === "PATCH") {
			failPatch = false;
			await readBody(req);
			incusError(res, 500, "device add failed");
			return;
		}
		original(req, res);
	};

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({
		code: "OPERATION_FAILED",
	});
	await provider.resetDocker("ws-test", { dockerGiB: 20 });

	expect(state.devices).toEqual(before);
	expect(state.volumes.get("ws-test-docker")).toBe("20GiB");
	expect(state.deleted.every((v) => v === "ws-test-docker")).toBe(true);
});

test("rebuild sends the image alias, keeps every device, and returns the fingerprint", async () => {
	const state = fakeIncus();
	const before = structuredClone(state.devices);
	serveIncus(state);

	const result = await provider.rebuild("ws-test", {
		resetDocker: false,
		dockerGiB: 20,
	});

	expect(result).toEqual({ imageFingerprint: "newfingerprint" });
	expect(state.rebuilds).toEqual([{ source: { type: "image", alias: "portikus" } }]);
	expect(state.devices).toEqual(before);
	expect(state.deleted).toHaveLength(0);
	expect(state.puts).toHaveLength(0);
});

test("rebuild refuses a running instance before asking Incus", async () => {
	const state = fakeIncus();
	state.status = "Running";
	serveIncus(state);

	await expect(
		provider.rebuild("ws-test", { resetDocker: true, dockerGiB: 20 }),
	).rejects.toBeInstanceOf(InstanceNotStoppedError);
	expect(state.rebuilds).toHaveLength(0);
	expect(state.deleted).toHaveLength(0);
});

test("rebuild with a Docker reset replaces only the docker volume", async () => {
	const state = fakeIncus();
	const before = structuredClone(state.devices);
	serveIncus(state);

	await provider.rebuild("ws-test", { resetDocker: true, dockerGiB: 20 });

	expect(state.rebuilds).toHaveLength(1);
	expect(state.deleted).toEqual(["ws-test-docker"]);
	expect(state.devices).toEqual(before);
});

test("start gives an old workspace its recovery volume and never creates home", async () => {
	const state = fakeIncus();
	const { recovery: _r, ...rest } = state.devices;
	state.devices = rest;
	state.volumes.delete("ws-test-recovery");
	serveIncus(state);

	await provider.start("ws-test", { ...START, recoveryGiB: 3 });

	expect(state.createdVolumes).toEqual(["ws-test-recovery"]);
	expect(state.volumes.get("ws-test-recovery")).toBe("3GiB");
	// Added by PATCH, which merges, so nothing else can drop.
	expect(state.patches).toEqual([
		{ devices: { recovery: disk("ws-test-recovery", "/var/lib/portikus/recovery") } },
	]);
	expect(state.puts).toHaveLength(0);
	expect(state.execs).toContainEqual([
		"chown",
		"1000:1000",
		"/var/lib/portikus/recovery",
	]);
	expect(state.execs).toContainEqual(["chmod", "0700", "/var/lib/portikus/recovery"]);
});

test("a reset that failed after taking Docker off is put back by the next start", async () => {
	const state = fakeIncus();
	const before = structuredClone(state.devices);
	serveIncus(state);
	const original = handler;
	let failDelete = true;
	handler = async (req, res) => {
		if (failDelete && req.method === "DELETE") {
			failDelete = false;
			await readBody(req);
			incusError(res, 500, "lvremove failed");
			return;
		}
		original(req, res);
	};

	await expect(
		provider.resetDocker("ws-test", { dockerGiB: 20 }),
	).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	expect(state.devices.docker).toBeUndefined();

	await provider.start("ws-test", { ...START, dockerGiB: 20, recoveryGiB: 3 });

	expect(state.devices).toEqual(before);
	// The old volume was never deleted, so it is reused, not recreated.
	expect(state.createdVolumes).toHaveLength(0);
	expect(state.patches).toEqual([
		{ devices: { docker: disk("ws-test-docker", "/var/lib/docker") } },
	]);
});

test("a failed Docker re-attach fails the start", async () => {
	const state = fakeIncus();
	const { docker: _d, ...rest } = state.devices;
	state.devices = rest;
	state.volumes.delete("ws-test-docker");
	state.failVolumeCreate = true;
	serveIncus(state);

	await expect(
		provider.start("ws-test", { ...START, dockerGiB: 20 }),
	).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	expect(state.status).toBe("Stopped");
});

test("start with the Docker device on leaves it alone", async () => {
	const state = fakeIncus();
	serveIncus(state);

	await provider.start("ws-test", { ...START, dockerGiB: 20 });

	expect(state.createdVolumes).toHaveLength(0);
	expect(state.patches).toHaveLength(0);
});

test("start with the recovery device already on only fixes the mount's owner", async () => {
	const state = fakeIncus();
	serveIncus(state);

	await provider.start("ws-test", { ...START, recoveryGiB: 3 });

	expect(state.createdVolumes).toHaveLength(0);
	expect(state.patches).toHaveLength(0);
	expect(state.execs).toContainEqual([
		"chown",
		"1000:1000",
		"/var/lib/portikus/recovery",
	]);
});

test("a failed recovery attach still starts the workspace", async () => {
	const state = fakeIncus();
	const { recovery: _r, ...rest } = state.devices;
	state.devices = rest;
	state.volumes.delete("ws-test-recovery");
	state.failVolumeCreate = true;
	serveIncus(state);

	const result = await provider.start("ws-test", { ...START, recoveryGiB: 3 });

	expect(result.ipv4).toBe("127.0.0.1");
	expect(state.status).toBe("Running");
	expect(state.devices.recovery).toBeUndefined();
	// No mount to fix, and chown must not run against a missing path.
	expect(state.execs.some((c) => c[0] === "chown")).toBe(false);
});

test("a failed chown of the recovery mount still starts the workspace", async () => {
	const state = fakeIncus();
	serveIncus(state);
	const original = handler;
	handler = async (req, res) => {
		if (req.url?.includes("/exec")) {
			const body = await readBody(req);
			if (JSON.parse(body).command[0] === "chown") {
				incusError(res, 500, "exec failed");
				return;
			}
			respond(res, 200, sync({}));
			return;
		}
		original(req, res);
	};

	const result = await provider.start("ws-test", { ...START, recoveryGiB: 3 });
	expect(result.ipv4).toBe("127.0.0.1");
});

test("start without a recovery size skips the recovery step entirely", async () => {
	const state = fakeIncus();
	const { recovery: _r, ...rest } = state.devices;
	state.devices = rest;
	serveIncus(state);

	await provider.start("ws-test", START);

	expect(state.createdVolumes).toHaveLength(0);
	expect(state.patches).toHaveLength(0);
	expect(state.execs.some((c) => c[0] === "chown")).toBe(false);
});

// Resource guard (ADR 0032): usage from one Incus listing, and the CPU
// allowance written through the ETag-guarded PUT.

function usageProvider(cgroupRoot: string): IncusWorkspaceProvider {
	return new IncusWorkspaceProvider({
		client: new IncusClient({ socketPath, project: "portikus" }),
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort,
		cgroupRoot,
		hostCpuCount: 8,
	});
}

function writeMemoryStat(root: string, instance: string, inactiveFile: number): void {
	const dir = path.join(root, `lxc.payload.portikus_${instance}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "memory.stat"),
		`anon 100\nfile 200\ninactive_file ${inactiveFile}\n`,
	);
}

function listed(
	name: string,
	status: string,
	expanded: Record<string, string>,
	state: { cpu: number; memory: number; total?: number; pid?: number } | null,
) {
	return {
		name,
		status,
		config: {},
		expanded_config: expanded,
		// Incus 7.4 reports pid 0 when it has no init process.
		state: state && {
			pid: state.pid ?? 0,
			cpu: { usage: state.cpu, allocated_time: 0 },
			memory: { usage: state.memory, total: state.total ?? 0, usage_peak: 0 },
		},
	};
}

test("usage reports running instances only, with limits, working set and allowance", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cgroup-"));
	writeMemoryStat(root, "ws-a", 1_000);
	writeMemoryStat(root, "ws-c", 0);
	const urls: string[] = [];
	handler = async (req, res) => {
		urls.push(req.url ?? "");
		respond(
			res,
			200,
			sync([
				listed(
					"ws-a",
					"Running",
					{
						"limits.cpu": "4",
						"limits.memory": "6GiB",
						"limits.cpu.allowance": "100ms/100ms",
						"volatile.base_image": "x",
					},
					{ cpu: 123_456_789, memory: 5_000, pid: 4242 },
				),
				listed("ws-b", "Stopped", { "limits.cpu": "4", "limits.memory": "6GiB" }, null),
				listed(
					"ws-c",
					"Running",
					{ "limits.memory": "4GB" },
					{ cpu: 7, memory: 2_000 },
				),
			]),
		);
	};

	const result = await usageProvider(root).usage();

	expect(urls).toEqual(["/1.0/instances?recursion=2&project=portikus"]);
	expect(result).toEqual([
		{
			name: "ws-a",
			cpuUsageNs: 123_456_789,
			// The host PID of the instance's init marks the boot.
			bootMarker: 4242,
			cpuLimit: 4,
			// Page cache is left out: 5,000 used less 1,000 inactive file.
			memoryBytes: 4_000,
			memoryLimitBytes: 6 * 2 ** 30,
			cpuAllowance: "100ms/100ms",
		},
		{
			name: "ws-c",
			cpuUsageNs: 7,
			// No PID reported: no marker, so the guard falls back to the counter.
			bootMarker: null,
			// No limits.cpu: the host's CPU count.
			cpuLimit: 8,
			memoryBytes: 2_000,
			memoryLimitBytes: 4e9,
			cpuAllowance: null,
		},
	]);
});

test("usage reads limits.memory in every unit Incus uses", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cgroup-"));
	const units: Array<[string, number]> = [
		["1073741824", 2 ** 30],
		["512B", 512],
		["2kB", 2e3],
		["2KB", 2e3],
		["3MB", 3e6],
		["4GB", 4e9],
		["1TB", 1e12],
		["2KiB", 2 * 2 ** 10],
		["3MiB", 3 * 2 ** 20],
		["6GiB", 6 * 2 ** 30],
		["1TiB", 2 ** 40],
	];
	for (const [i] of units.entries()) writeMemoryStat(root, `ws-${i}`, 0);
	handler = (_req, res) => {
		respond(
			res,
			200,
			sync(
				units.map(([size], i) =>
					listed(
						`ws-${i}`,
						"Running",
						{ "limits.memory": size },
						{ cpu: 1, memory: 1 },
					),
				),
			),
		);
	};

	const result = await usageProvider(root).usage();

	expect(result.map((u) => u.memoryLimitBytes)).toEqual(
		units.map(([, bytes]) => bytes),
	);
});

test("usage falls back to Incus's figures when limits.memory or memory.stat is missing", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cgroup-"));
	handler = (_req, res) => {
		respond(
			res,
			200,
			sync([
				listed("ws-a", "Running", {}, { cpu: 1, memory: 3_000, total: 9_000 }),
				listed("ws-b", "Running", {}, { cpu: 1, memory: 3_000, total: 0 }),
			]),
		);
	};

	const result = await usageProvider(root).usage();

	// No memory.stat: the raw figure. No limit anywhere: the instance is skipped.
	expect(result).toEqual([
		{
			name: "ws-a",
			cpuUsageNs: 1,
			bootMarker: null,
			cpuLimit: 8,
			memoryBytes: 3_000,
			memoryLimitBytes: 9_000,
			cpuAllowance: null,
		},
	]);
});

test("setting the CPU allowance writes it back through the ETag-guarded PUT", async () => {
	const state = fakeIncus();
	state.status = "Running";
	serveIncus(state);
	const before = structuredClone(state);

	await provider.setCpuAllowance("ws-test", "100ms/100ms");

	expect(state.puts).toHaveLength(1);
	const put = state.puts[0];
	if (!put) throw new Error("expected a PUT");
	expect(put.ifMatch).toBe('"e1"');
	expect(put.body.config).toEqual({
		...before.config,
		"limits.cpu.allowance": "100ms/100ms",
	});
	expect(put.body.devices).toEqual(before.devices);
	expect(put.body.profiles).toEqual(["workspace"]);
	expect(state.patches).toHaveLength(0);

	// Asking again for the same value writes nothing.
	await provider.setCpuAllowance("ws-test", "100ms/100ms");
	expect(state.puts).toHaveLength(1);
});

test("removing the CPU allowance drops only that key", async () => {
	const state = fakeIncus();
	state.status = "Running";
	state.config = { ...state.config, "limits.cpu.allowance": "100ms/100ms" };
	serveIncus(state);
	const before = structuredClone(state);

	await provider.setCpuAllowance("ws-test", null);

	expect(state.puts).toHaveLength(1);
	expect(state.config).toEqual({ "volatile.base_image": "old", "image.os": "debian" });
	expect(state.devices).toEqual(before.devices);

	// Nothing left to remove: no write.
	await provider.setCpuAllowance("ws-test", null);
	expect(state.puts).toHaveLength(1);
});

test("a stale ETag refuses the allowance write", async () => {
	const state = fakeIncus();
	state.staleEtag = true;
	serveIncus(state);

	await expect(
		provider.setCpuAllowance("ws-test", "100ms/100ms"),
	).rejects.toBeInstanceOf(Error);
	expect(state.config["limits.cpu.allowance"]).toBeUndefined();
});

test("the allowance must be a time slice; anything else never reaches Incus", async () => {
	const state = fakeIncus();
	serveIncus(state);
	for (const bad of [
		"25%",
		"0ms/100ms",
		"100ms",
		"100ms/200ms",
		"1000000ms/100ms",
		"",
	]) {
		await expect(provider.setCpuAllowance("ws-test", bad)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	}
	await expect(provider.setCpuAllowance("../etc", "100ms/100ms")).rejects.toMatchObject(
		{ code: "INVALID_NAME" },
	);
	expect(state.puts).toHaveLength(0);
});

test("start removes an allowance left on the stopped instance before starting it", async () => {
	const state = fakeIncus();
	state.config = { ...state.config, "limits.cpu.allowance": "100ms/100ms" };
	serveIncus(state);
	const original = handler;
	let statusAtPut = "";
	handler = (req, res) => {
		if (req.method === "PUT" && req.url?.startsWith("/1.0/instances/ws-test?")) {
			statusAtPut = state.status;
		}
		original(req, res);
	};

	await provider.start("ws-test", START);

	expect(statusAtPut).toBe("Stopped");
	expect(state.puts).toHaveLength(1);
	expect(state.puts[0]?.ifMatch).toBe('"e1"');
	expect(state.config["limits.cpu.allowance"]).toBeUndefined();
	expect(state.status).toBe("Running");
});

/** Wraps serveIncus: counts start PUTs and answers them with a failed operation when `fail` is set. */
function countStarts(state: FakeIncus, fail: string | null) {
	serveIncus(state);
	const original = handler;
	const seen = { starts: 0 };
	handler = (req, res) => {
		if (req.method === "PUT" && req.url?.startsWith("/1.0/instances/ws-test/state")) {
			seen.starts++;
			if (fail !== null) {
				respond(res, 202, {
					type: "async",
					status: "Operation created",
					status_code: 100,
					operation: "/1.0/operations/start-1",
				});
				return;
			}
		}
		if (fail !== null && req.url?.includes("/operations/start-1/wait")) {
			respond(res, 200, sync({ status_code: 400, status: "Failure", err: fail }));
			return;
		}
		original(req, res);
	};
	return seen;
}

test("a retried start of an instance Incus already runs skips the start and finishes the rest", async () => {
	const state = fakeIncus();
	state.status = "Running";
	const seen = countStarts(state, null);

	await provider.start("ws-test", START);

	expect(seen.starts).toBe(0);
	expect(agentRequests).toBeGreaterThan(0);
});

test("a start that Incus refuses because the instance is already running goes on", async () => {
	const state = fakeIncus();
	const seen = countStarts(state, "The instance is already running");

	await provider.start("ws-test", START);

	expect(seen.starts).toBe(1);
});

test("a start that fails while the instance is not running is an error", async () => {
	const state = fakeIncus();
	countStarts(state, "Failed to run: startup failed");
	serveIncusStateAs("Stopped");

	await expect(provider.start("ws-test", START)).rejects.toMatchObject({
		code: "OPERATION_FAILED",
		message: "Failed to run: startup failed",
	});
});

/** Makes the state read report `status` instead of a running instance. */
function serveIncusStateAs(status: string): void {
	const original = handler;
	handler = (req, res) => {
		if (req.method === "GET" && req.url?.startsWith("/1.0/instances/ws-test/state")) {
			respond(res, 200, sync({ status }));
			return;
		}
		original(req, res);
	};
}

test("start without an allowance makes no guarded write", async () => {
	const state = fakeIncus();
	serveIncus(state);

	await provider.start("ws-test", START);

	expect(state.puts).toHaveLength(0);
});

describe("processes", () => {
	const BASE = 1_000_000;
	let root: string;

	function writeProc(hostPid: number, nsPid: number, uid: number, name: string): void {
		const dir = path.join(root, "proc", String(hostPid));
		fs.mkdirSync(dir, { recursive: true });
		const rest = Array.from({ length: 22 }, () => "0").join(" ");
		fs.writeFileSync(path.join(dir, "stat"), `${hostPid} (${name}) ${rest}\n`);
		fs.writeFileSync(
			path.join(dir, "status"),
			`Uid:\t${uid + BASE}\t0\t0\t0\nNSpid:\t${hostPid}\t${nsPid}\nVmRSS:\t4 kB\n`,
		);
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-procs-"));
		fs.mkdirSync(path.join(root, "proc"));
		fs.writeFileSync(path.join(root, "proc", "uptime"), "100.0 1.0\n");
		writeProc(4000, 1, 0, "systemd");
		writeProc(4001, 77, 1000, "burn");
		// The project is in the cgroup name for any project but default.
		const cg = path.join(root, "cgroup", "lxc.payload.testproj_ws-test");
		fs.mkdirSync(path.join(cg, "user.slice"), { recursive: true });
		fs.writeFileSync(path.join(cg, "cgroup.procs"), "4000\n");
		fs.writeFileSync(path.join(cg, "user.slice", "cgroup.procs"), "4001\n");
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function hostProvider(): IncusWorkspaceProvider {
		return new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort: 1,
			cgroupRoot: path.join(root, "cgroup"),
			procRoot: path.join(root, "proc"),
		});
	}

	function fakeIncus(status = "Running", pid = 4000) {
		const seen: string[] = [];
		handler = (req, res) => {
			const p = (req.url ?? "").split("?")[0] ?? "";
			seen.push(`${req.method} ${p}`);
			if (req.method === "GET" && p === "/1.0/instances/ws-test") {
				respond(
					res,
					200,
					sync({
						config: {
							"volatile.idmap.current": JSON.stringify([
								{ Isuid: true, Isgid: false, Hostid: BASE, Nsid: 0, Maprange: 65536 },
							]),
						},
						expanded_config: { "limits.cpu": "2" },
					}),
				);
			} else if (req.method === "GET" && p === "/1.0/instances/ws-test/state") {
				respond(res, 200, sync({ status, pid }));
			} else {
				respond(res, 404, { type: "error", error: "not found", error_code: 404 });
			}
		};
		return seen;
	}

	test("reads the host's /proc and cgroup tree and asks Incus only for metadata", async () => {
		const seen = fakeIncus();
		const rows = await hostProvider().processes("ws-test");
		expect(rows.map((r) => [r.pid, r.uid, r.name, r.protected])).toEqual([
			[1, 0, "systemd", true],
			[77, 1000, "burn", false],
		]);
		expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
	});

	test("refuses a stopped instance without reading anything", async () => {
		const seen = fakeIncus("Stopped", 0);
		await expect(hostProvider().processes("ws-test")).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
		expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
	});

	test("reports an unreadable cgroup tree as an operation failure", async () => {
		fakeIncus();
		fs.rmSync(path.join(root, "cgroup"), { recursive: true });
		await expect(hostProvider().processes("ws-test")).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});
});

// Admin operations (SPEC.md §19.3, §20.1): limits, the package list, kept
// volumes and Replace home.
describe("admin operations", () => {
	const WS = "ws-0123456789abcdef01234567";
	const POOL = "/1.0/storage-pools/mypool/volumes/custom";

	interface OpsState {
		status: string;
		config: Record<string, string>;
		devices: Record<string, Record<string, string>>;
		etagSeq: number;
		/** Volume name to its snapshots. */
		volumes: Map<string, string[]>;
		usedBy: Map<string, string[]>;
		file: { status: number; type: string; body: string } | null;
		requests: string[];
		/** Fail the first request whose "METHOD path" starts with this, once. */
		failOnce: string | null;
	}

	function opsState(): OpsState {
		return {
			status: "Stopped",
			config: { "image.os": "debian", "limits.cpu": "2" },
			devices: {
				home: disk(`${WS}-home`, "/home/student"),
				docker: disk(`${WS}-docker`, "/var/lib/docker"),
			},
			etagSeq: 1,
			volumes: new Map([
				[`${WS}-home`, []],
				[`${WS}-docker`, []],
			]),
			usedBy: new Map(),
			file: null,
			requests: [],
			failOnce: null,
		};
	}

	function serveOps(state: OpsState): void {
		handler = async (req, res) => {
			const body = await readBody(req);
			const url = new URL(req.url ?? "/", "http://incus");
			const p = decodeURIComponent(url.pathname);
			const method = req.method ?? "";
			const key = `${method} ${p}`;
			state.requests.push(key);
			if (state.failOnce && key.startsWith(state.failOnce)) {
				state.failOnce = null;
				incusError(res, 500, "interrupted");
				return;
			}
			const etag = `"e${state.etagSeq}"`;
			if (p === `/1.0/instances/${WS}` && method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
				res.end(
					JSON.stringify(
						sync({
							name: WS,
							status: state.status,
							architecture: "x86_64",
							config: state.config,
							devices: state.devices,
							ephemeral: false,
							profiles: ["workspace"],
							stateful: false,
							description: "",
						}),
					),
				);
			} else if (p === `/1.0/instances/${WS}` && method === "PUT") {
				if (req.headers["if-match"] !== etag) {
					incusError(res, 412, "ETag doesn't match");
					return;
				}
				const parsed = JSON.parse(body);
				state.config = parsed.config;
				state.devices = parsed.devices;
				state.etagSeq++;
				respond(res, 200, sync({}));
			} else if (p === `/1.0/instances/${WS}` && method === "PATCH") {
				state.devices = { ...state.devices, ...JSON.parse(body).devices };
				state.etagSeq++;
				respond(res, 200, sync({}));
			} else if (p === `/1.0/instances/${WS}/files` && method === "GET") {
				if (!state.file) {
					incusError(res, 404, "not found");
					return;
				}
				res.writeHead(state.file.status, {
					"Content-Type": "application/octet-stream",
					"X-Incus-type": state.file.type,
				});
				res.end(state.file.body);
			} else if (p === POOL && method === "GET") {
				respond(
					res,
					200,
					sync(
						[...state.volumes.keys()].map((name) => ({
							name,
							created_at: `created-${name}`,
						})),
					),
				);
			} else if (p.startsWith(`${POOL}/`)) {
				const rest = p.slice(POOL.length + 1).split("/");
				const volume = rest[0] ?? "";
				const snapshots = state.volumes.get(volume);
				if (!snapshots) {
					incusError(res, 404, "Storage volume not found");
				} else if (rest.length === 1 && method === "GET") {
					respond(
						res,
						200,
						sync({ name: volume, used_by: state.usedBy.get(volume) ?? [] }),
					);
				} else if (rest.length === 1 && method === "POST") {
					const { name } = JSON.parse(body);
					state.volumes.delete(volume);
					state.volumes.set(name, snapshots);
					respond(res, 200, sync({}));
				} else if (rest.length === 1 && method === "DELETE") {
					state.volumes.delete(volume);
					respond(res, 200, sync({}));
				} else if (rest[1] === "snapshots" && rest.length === 2) {
					respond(
						res,
						200,
						sync(
							snapshots.map((s) => ({ name: `${volume}/${s}`, created_at: `at-${s}` })),
						),
					);
				} else if (rest[1] === "snapshots" && method === "DELETE") {
					state.volumes.set(
						volume,
						snapshots.filter((s) => s !== rest[2]),
					);
					respond(res, 200, sync({}));
				} else {
					incusError(res, 404, `unexpected ${key}`);
				}
			} else {
				incusError(res, 404, `unexpected ${key}`);
			}
		};
	}

	let ops: IncusWorkspaceProvider;
	beforeEach(() => {
		ops = usageProvider(fs.mkdtempSync(path.join(os.tmpdir(), "ops-cgroup-")));
	});

	test("setLimits writes the instance's own keys and removes a null one", async () => {
		const state = opsState();
		serveOps(state);

		await ops.setLimits(WS, { cpu: 4, memoryMiB: 2048, processes: null });
		expect(state.config).toEqual({
			"image.os": "debian",
			"limits.cpu": "4",
			"limits.memory": "2048MiB",
		});

		await ops.setLimits(WS, { cpu: null, memoryMiB: 2048, processes: 1000 });
		expect(state.config).toEqual({
			"image.os": "debian",
			"limits.memory": "2048MiB",
			"limits.processes": "1000",
		});
		expect(state.devices.home?.source).toBe(`${WS}-home`);

		// The same values again write nothing.
		const puts = state.requests.filter((r) => r.startsWith("PUT")).length;
		await ops.setLimits(WS, { cpu: null, memoryMiB: 2048, processes: 1000 });
		expect(state.requests.filter((r) => r.startsWith("PUT")).length).toBe(puts);
	});

	test("setLimits refuses more CPUs than the host has before touching Incus", async () => {
		const state = opsState();
		serveOps(state);
		await expect(
			ops.setLimits(WS, { cpu: 9, memoryMiB: null, processes: null }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(state.requests).toEqual([]);
	});

	test("start with an allowance sets it before the instance runs", async () => {
		const state = fakeIncus();
		serveIncus(state);
		const original = handler;
		let statusAtPut = "";
		handler = (req, res) => {
			if (req.method === "PUT" && req.url?.startsWith("/1.0/instances/ws-test?")) {
				statusAtPut = state.status;
			}
			original(req, res);
		};

		await provider.start("ws-test", { ...START, cpuAllowance: "50ms/100ms" });

		expect(statusAtPut).toBe("Stopped");
		expect(state.config["limits.cpu.allowance"]).toBe("50ms/100ms");
		expect(state.status).toBe("Running");
		await expect(
			provider.start("ws-test", { ...START, cpuAllowance: "50%" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("addedPackages reads the list and keeps only package names", async () => {
		const state = opsState();
		state.file = {
			status: 200,
			type: "file",
			body: "# portikus-image: 2026.09.9\nhtop\n$(reboot)\n../x\nripgrep\n",
		};
		serveOps(state);
		expect(await ops.addedPackages(WS)).toEqual({
			image: "2026.09.9",
			packages: ["htop", "ripgrep"],
		});
		expect(state.requests).toEqual([`GET /1.0/instances/${WS}/files`]);
	});

	test("addedPackages reads a missing file, a symbolic link or a directory as no list, and refuses an oversized one", async () => {
		const state = opsState();
		serveOps(state);
		const none = { image: null, packages: [] };
		expect(await ops.addedPackages(WS)).toEqual(none);
		state.file = { status: 200, type: "symlink", body: "/etc/shadow" };
		expect(await ops.addedPackages(WS)).toEqual(none);
		state.file = { status: 200, type: "directory", body: "[]" };
		expect(await ops.addedPackages(WS)).toEqual(none);
		state.file = { status: 200, type: "file", body: "a\n".repeat(40 * 1024) };
		await expect(ops.addedPackages(WS)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		state.failOnce = `GET /1.0/instances/${WS}/files`;
		await expect(ops.addedPackages(WS)).rejects.not.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("keptVolumes lists pre-change snapshots and kept homes only", async () => {
		const state = opsState();
		state.volumes.set(`${WS}-home`, ["pre-upgrade", "portikus-backup"]);
		state.volumes.set(`${WS}-home-replaced-1790000000`, ["pre-old"]);
		state.volumes.set("other-volume", ["pre-x"]);
		serveOps(state);

		expect(await ops.keptVolumes()).toEqual({
			snapshots: [
				{ volume: `${WS}-home`, name: "pre-upgrade", createdAt: "at-pre-upgrade" },
			],
			keptHomes: [
				{
					volume: `${WS}-home-replaced-1790000000`,
					instance: WS,
					createdAt: `created-${WS}-home-replaced-1790000000`,
				},
			],
		});
	});

	test("deleteSnapshot deletes a pre-change snapshot and refuses any other", async () => {
		const state = opsState();
		state.volumes.set(`${WS}-home`, ["pre-upgrade", "portikus-backup"]);
		serveOps(state);

		for (const [volume, snapshot] of [
			[`${WS}-home`, "portikus-backup"],
			[`${WS}-home`, "pre-a/../b"],
			["ws-test-home", "pre-upgrade"],
			[`${WS}-home-replaced-1`, "pre-upgrade"],
		] as const) {
			await expect(ops.deleteSnapshot(volume, snapshot)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
		expect(state.requests).toEqual([]);

		await ops.deleteSnapshot(`${WS}-home`, "pre-upgrade");
		expect(state.volumes.get(`${WS}-home`)).toEqual(["portikus-backup"]);
	});

	test("deleteKeptHome deletes only an unused kept home", async () => {
		const state = opsState();
		const kept = `${WS}-home-replaced-1790000000`;
		state.volumes.set(kept, []);
		state.usedBy.set(kept, [`/1.0/instances/${WS}`]);
		serveOps(state);

		await expect(ops.deleteKeptHome(`${WS}-home`)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(ops.deleteKeptHome(kept)).rejects.toBeInstanceOf(VolumeInUseError);
		expect(state.volumes.has(kept)).toBe(true);

		state.usedBy.delete(kept);
		await ops.deleteKeptHome(kept);
		expect(state.volumes.has(kept)).toBe(false);
	});

	test("replaceHome refuses a running instance and touches nothing", async () => {
		const state = opsState();
		state.status = "Running";
		state.volumes.set(`${WS}-home-import`, []);
		serveOps(state);
		await expect(ops.replaceHome(WS)).rejects.toBeInstanceOf(InstanceNotStoppedError);
		expect(state.requests).toEqual([`GET /1.0/instances/${WS}`]);
	});

	test("replaceHome refuses when there is no imported home", async () => {
		const state = opsState();
		serveOps(state);
		await expect(ops.replaceHome(WS)).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(state.devices.home?.source).toBe(`${WS}-home`);
	});

	function expectSwapped(state: OpsState, kept: string): void {
		expect(kept).toMatch(new RegExp(`^${WS}-home-replaced-\\d+$`));
		expect(state.volumes.get(kept)).toEqual(["old-home"]);
		expect(state.volumes.get(`${WS}-home`)).toEqual(["imported"]);
		expect(state.volumes.has(`${WS}-home-import`)).toBe(false);
		expect(state.devices.home).toEqual(disk(`${WS}-home`, "/home/student"));
		expect(state.devices.docker).toEqual(disk(`${WS}-docker`, "/var/lib/docker"));
	}

	function swapState(): OpsState {
		const state = opsState();
		// Snapshot lists stand in for the volumes' contents.
		state.volumes.set(`${WS}-home`, ["old-home"]);
		state.volumes.set(`${WS}-home-import`, ["imported"]);
		return state;
	}

	test("replaceHome detaches, keeps the old home, renames the import and attaches", async () => {
		const state = swapState();
		serveOps(state);
		const { kept } = await ops.replaceHome(WS);
		expectSwapped(state, kept);
	});

	for (const [step, failOnce] of [
		["the detach", `PUT /1.0/instances/${WS}`],
		["keeping the old home", `POST ${POOL}/${WS}-home`],
		["renaming the import", `POST ${POOL}/${WS}-home-import`],
		["the attach", `PATCH /1.0/instances/${WS}`],
	] as const) {
		test(`a replaceHome interrupted at ${step} is finished by a retry`, async () => {
			const state = swapState();
			state.failOnce = failOnce;
			serveOps(state);
			await expect(ops.replaceHome(WS)).rejects.toBeInstanceOf(Error);
			expect(state.failOnce).toBeNull();
			// Nothing is lost at any point: both homes still exist under some name.
			const contents = [...state.volumes.values()].flat();
			expect(contents).toContain("old-home");
			expect(contents).toContain("imported");

			const { kept } = await ops.replaceHome(WS);
			expectSwapped(state, kept);
			expect([...state.volumes.keys()].filter((v) => v.includes("replaced"))).toEqual([
				kept,
			]);
		});
	}
});

// Issue #887: the agent's start time and the image come from the host, and
// the only thing run inside the instance is a fixed systemctl restart.
describe("restarting outdated agents", () => {
	let root: string;
	const AGENT_UNIT = "system.slice/portikus-workspace-agent.service";

	function statLine(pid: number, start: number): string {
		const rest = Array.from({ length: 22 }, () => "0");
		rest[0] = "S";
		rest[19] = String(start);
		return `${pid} (node) ${rest.join(" ")}\n`;
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-restart-"));
		fs.mkdirSync(path.join(root, "proc", "5000"), { recursive: true });
		fs.mkdirSync(path.join(root, "proc", "5001"), { recursive: true });
		fs.writeFileSync(path.join(root, "proc", "stat"), "cpu 1 2 3\nbtime 1790000000\n");
		// The oldest process in the unit is its main one; 5001 is a child.
		fs.writeFileSync(path.join(root, "proc", "5000", "stat"), statLine(5000, 12_345));
		fs.writeFileSync(path.join(root, "proc", "5001", "stat"), statLine(5001, 99_999));
		const unit = path.join(root, "cgroup", "lxc.payload.testproj_ws-a", AGENT_UNIT);
		fs.mkdirSync(unit, { recursive: true });
		fs.writeFileSync(path.join(unit, "cgroup.procs"), "5001\n5000\n");
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function hostProvider(): IncusWorkspaceProvider {
		return new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort: 1,
			cgroupRoot: path.join(root, "cgroup"),
			procRoot: path.join(root, "proc"),
		});
	}

	test("reads each running agent's start from the host and the image from Incus", async () => {
		handler = (_req, res) => {
			respond(
				res,
				200,
				sync([
					{ name: "ws-a", status: "Running", config: { "image.serial": "2026.09.14" } },
					{ name: "ws-b", status: "Running", config: {} },
					{ name: "ws-c", status: "Stopped", config: { "image.serial": "2026.09.14" } },
				]),
			);
		};
		const agents = await hostProvider().runningAgents();
		expect(agents).toEqual([
			{
				name: "ws-a",
				imageSerial: "2026.09.14",
				startedAt: new Date((1_790_000_000 + 123.45) * 1000),
			},
			{ name: "ws-b", imageSerial: null, startedAt: null },
		]);
	});

	test("restartAgent runs a fixed systemctl restart and reports a failure", async () => {
		const commands: unknown[] = [];
		let code = 0;
		handler = async (req, res) => {
			commands.push(JSON.parse(await readBody(req)).command);
			respond(res, 200, sync({ status_code: 200, metadata: { return: code } }));
		};
		await hostProvider().restartAgent("ws-a");
		expect(commands).toEqual([
			["systemctl", "restart", "portikus-workspace-agent.service"],
		]);
		code = 1;
		await expect(hostProvider().restartAgent("ws-a")).rejects.toThrow("exited 1");
		await expect(hostProvider().restartAgent("../x")).rejects.toMatchObject({
			code: "INVALID_NAME",
		});
	});
});

// Shared Docker pull storage (issue #840): seed copies, the registry
// settings written before a start, and the seed builder.
describe("the Docker seed", () => {
	const GIB = 1024 ** 3;
	const SEED = {
		images: ["python:3.12"],
		sizeBytes: 2.5 * GIB,
		imageVersion: "2026.09.9",
		builtAt: "2026-09-30T12:00:00.000Z",
	};

	function withSeed(state: FakeIncus): FakeIncus {
		state.volumes.set("portikus-docker-seed", "12GiB");
		state.volumeConfigs.set("portikus-docker-seed", {
			size: "12GiB",
			[SEED_INFO_KEY]: JSON.stringify(SEED),
			"security.shifted": "true",
		});
		return state;
	}

	function freshCreate(): FakeIncus {
		const state = fakeIncus();
		state.volumes.clear();
		state.devices = {};
		return state;
	}

	test("create copies the seed into the Docker volume, sized at Docker plus the seed", async () => {
		const state = withSeed(freshCreate());
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		const docker = state.volumeBodies.find((b) => b.name === "ws-test-docker");
		expect(docker).toEqual({
			name: "ws-test-docker",
			config: {
				size: "23GiB",
				"security.shifted": "true",
				"user.portikus.seed-gib": "3",
			},
			source: { type: "copy", pool: "mypool", name: "portikus-docker-seed" },
		});
		// Home and recovery are never copies.
		for (const name of ["ws-test-home", "ws-test-recovery"]) {
			expect(state.volumeBodies.find((b) => b.name === name)).not.toHaveProperty(
				"source",
			);
		}
	});

	test("a copy is never smaller than the seed volume it copies (F4)", async () => {
		const state = withSeed(freshCreate());
		state.volumes.set("portikus-docker-seed", "30GiB");
		state.volumeConfigs.set("portikus-docker-seed", {
			size: "30GiB",
			[SEED_INFO_KEY]: JSON.stringify(SEED),
		});
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		const docker = state.volumeBodies.find((b) => b.name === "ws-test-docker");
		expect(docker?.config).toEqual({
			size: "30GiB",
			"security.shifted": "true",
			"user.portikus.seed-gib": "10",
		});
	});

	test("the seed itself is never attached to an instance, only its copy to its own", async () => {
		const state = withSeed(freshCreate());
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		const devices = state.instanceCreates[0]?.devices ?? {};
		const sources = Object.values(devices).map((d) => d.source);
		expect(sources).not.toContain("portikus-docker-seed");
		expect(devices.docker?.source).toBe("ws-test-docker");
	});

	test("no seed means today's empty volume", async () => {
		const state = freshCreate();
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		expect(state.volumeBodies.find((b) => b.name === "ws-test-docker")).toEqual({
			name: "ws-test-docker",
			config: { size: "20GiB" },
		});
	});

	test("a seed with unreadable info is treated as no seed", async () => {
		const state = withSeed(freshCreate());
		state.volumeConfigs.set("portikus-docker-seed", { [SEED_INFO_KEY]: "{broken" });
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		expect(
			state.volumeBodies.find((b) => b.name === "ws-test-docker"),
		).not.toHaveProperty("source");
	});

	test("a failed copy falls back to an empty volume", async () => {
		const state = withSeed(freshCreate());
		state.failCopy = true;
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		const docker = state.volumeBodies.filter((b) => b.name === "ws-test-docker");
		expect(docker).toHaveLength(2);
		expect(docker[0]).toHaveProperty("source");
		expect(docker[1]).toEqual({ name: "ws-test-docker", config: { size: "20GiB" } });
		expect(state.volumes.get("ws-test-docker")).toBe("20GiB");
	});

	test("an existing Docker volume is kept, never replaced by a copy", async () => {
		const state = withSeed(freshCreate());
		state.volumes.set("ws-test-docker", "20GiB");
		serveIncus(state);
		await provider.create("ws-test", SIZES);
		expect(state.deleted).toEqual([]);
		expect(state.createdVolumes).not.toContain("ws-test-docker");
	});

	test("start never touches an attached Docker volume, seed or not", async () => {
		const state = withSeed(fakeIncus());
		serveIncus(state);
		await provider.start("ws-test", { ...START, dockerGiB: 20 });
		expect(state.volumeBodies).toEqual([]);
		expect(state.deleted).toEqual([]);
	});

	test("Reset Docker makes the new volume as a copy of the seed", async () => {
		const state = withSeed(fakeIncus());
		serveIncus(state);
		await provider.resetDocker("ws-test", { dockerGiB: 30 });
		expect(state.deleted).toEqual(["ws-test-docker"]);
		expect(state.volumeBodies).toEqual([
			{
				name: "ws-test-docker",
				config: {
					size: "33GiB",
					"security.shifted": "true",
					"user.portikus.seed-gib": "3",
				},
				source: { type: "copy", pool: "mypool", name: "portikus-docker-seed" },
			},
		]);
	});

	test("rebuild with Reset Docker copies the seed; without it the volume stays", async () => {
		const state = withSeed(fakeIncus());
		serveIncus(state);
		await provider.rebuild("ws-test", { resetDocker: false, dockerGiB: 20 });
		expect(state.volumeBodies).toEqual([]);
		await provider.rebuild("ws-test", { resetDocker: true, dockerGiB: 20 });
		expect(state.volumeBodies[0]).toHaveProperty("source.name", "portikus-docker-seed");
	});

	test("seedInfo reads back what was stored, and null without a seed", async () => {
		const state = fakeIncus();
		serveIncus(state);
		expect(await provider.seedInfo()).toBeNull();
		withSeed(state);
		expect(await provider.seedInfo()).toEqual(SEED);
	});

	test("start warns when the agent instructions template is missing", async () => {
		const state = fakeIncus();
		const { logger, lines } = collectingLogger();
		const own = new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort,
			thinPoolStatusPath: statusPath,
			agentInstructionsPath: path.join(os.tmpdir(), "no-such-e28-template.md"),
			logger,
		});
		serveIncus(state);
		await own.start("ws-test", START);
		expect(lines.some((l) => String(l.msg).includes("template is missing"))).toBe(true);
	});

	test("start rewrites the agents' system instructions, and a refusal does not stop it", async () => {
		const state = fakeIncus();
		const template = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-")), "t.md");
		fs.writeFileSync(template, "Platform rules\n");
		const own = new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort,
			thinPoolStatusPath: statusPath,
			agentInstructionsPath: template,
		});
		serveIncus(state);
		state.files.set("/etc/claude-code/CLAUDE.md", { type: "file", content: "edited" });
		await own.start("ws-test", START);
		expect(state.files.get("/etc/claude-code/CLAUDE.md")?.content).toBe(
			"Platform rules\n",
		);
		expect(state.files.get("/etc/codex/config.toml")?.content).toContain(
			'developer_instructions = "Platform rules\\n"',
		);

		state.files.set("/etc/claude-code", { type: "symlink", content: "/home/student" });
		await expect(own.start("ws-test", START)).resolves.toBeDefined();
	});

	test("start writes the registry settings before the instance starts", async () => {
		const state = fakeIncus();
		const ca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")), "ca.crt");
		fs.writeFileSync(ca, "CERT\n");
		const own = new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort,
			thinPoolStatusPath: statusPath,
			ghcrCaPath: ca,
		});
		serveIncus(state);
		await own.start("ws-test", { ...START, docker: { hubMirror: true, ghcr: true } });
		const daemonAt = state.log.indexOf("POST /1.0/instances/ws-test/files");
		const startAt = state.log.indexOf("PUT /1.0/instances/ws-test/state");
		expect(daemonAt).toBeGreaterThanOrEqual(0);
		expect(daemonAt).toBeLessThan(startAt);
		const daemon = JSON.parse(
			state.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
			"registry-mirrors": ["http://10.200.0.1:5000"],
		});
		expect(state.files.get("/etc/docker/certs.d/ghcr.io/ca.crt")?.content).toBe(
			"CERT\n",
		);
		expect(state.files.get("/etc/hosts")?.content).toMatch(/^10\.200\.0\.1 ghcr\.io /m);

		await own.start("ws-test", { ...START, docker: { hubMirror: false, ghcr: false } });
		expect(state.files.has("/etc/docker/certs.d/ghcr.io/ca.crt")).toBe(false);
		expect(state.files.get("/etc/hosts")?.content).not.toContain("ghcr.io");
	});

	test("the ghcr.io hosts line survives the first start's /etc/hosts template", async () => {
		const state = fakeIncus();
		const ca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")), "ca.crt");
		fs.writeFileSync(ca, "CERT\n");
		const own = new IncusWorkspaceProvider({
			client: new IncusClient({ socketPath, project: "testproj" }),
			pool: "mypool",
			profile: "workspace",
			imageAlias: "portikus",
			agentPort,
			thinPoolStatusPath: statusPath,
			ghcrCaPath: ca,
		});
		serveIncus(state);
		const ghcrLines = () =>
			(state.files.get("/etc/hosts")?.content ?? "")
				.split("\n")
				.filter((l) => l.includes("ghcr.io"));

		state.hostsTemplate = "127.0.0.1 localhost\n127.0.1.1 ws-test\n";
		await own.start("ws-test", { ...START, docker: { hubMirror: true, ghcr: true } });
		expect(ghcrLines()).toHaveLength(1);
		expect(ghcrLines()[0]).toMatch(/^10\.200\.0\.1 ghcr\.io /);

		state.status = "Stopped";
		await own.start("ws-test", { ...START, docker: { hubMirror: true, ghcr: true } });
		expect(ghcrLines()).toHaveLength(1);

		state.status = "Stopped";
		await own.start("ws-test", { ...START, docker: { hubMirror: true, ghcr: false } });
		expect(ghcrLines()).toEqual([]);
	});

	test("start without Docker settings leaves Docker's config alone", async () => {
		const state = fakeIncus();
		serveIncus(state);
		await provider.start("ws-test", START);
		expect(state.fileOps.filter((op) => op.includes("docker"))).toEqual([]);
	});

	test("a named pipe at /etc/docker writes nothing under it, and the workspace still starts", async () => {
		const state = fakeIncus();
		state.files.set("/etc/docker", { type: "fifo", content: "" });
		serveIncus(state);
		await provider.start("ws-test", {
			...START,
			docker: { hubMirror: true, ghcr: false },
		});
		expect(state.fileOps.filter((op) => /docker|hosts/.test(op))).toEqual([
			"POST /etc/docker",
		]);
		expect(state.status).toBe("Running");
	});
});

describe("the seed builder", () => {
	interface Builder {
		log: string[];
		bodies: Map<string, unknown[]>;
		exists: boolean;
		volumes: Set<string>;
		usedBy: string[];
		used: number;
		/** A volume whose rename Incus refuses. */
		failRename?: string;
	}

	function serveBuilder(): Builder {
		const b: Builder = {
			log: [],
			bodies: new Map(),
			exists: false,
			volumes: new Set(),
			usedBy: [],
			used: 3 * 1024 ** 3,
		};
		const vol = "/1.0/storage-pools/mypool/volumes/custom";
		handler = async (req, res) => {
			const body = await readBody(req);
			const url = new URL(req.url ?? "/", "http://incus");
			const p = url.pathname;
			const m = req.method ?? "";
			const key = `${m} ${p}${p.endsWith("/files") ? `?${url.searchParams.get("path")}` : ""}`;
			b.log.push(key);
			if (body && !p.endsWith("/files")) {
				b.bodies.set(key, [...(b.bodies.get(key) ?? []), JSON.parse(body)]);
			}
			const inst = `/1.0/instances/${SEED_BUILDER}`;
			const notFound = () => incusError(res, 404, "not found");
			if (p === "/1.0/instances" && m === "POST") {
				b.exists = true;
				respond(res, 200, sync({}));
			} else if (p === inst && m === "DELETE") {
				if (!b.exists) return notFound();
				b.exists = false;
				respond(res, 200, sync({}));
			} else if (p === `${inst}/state` && m === "PUT") {
				if (!b.exists) return notFound();
				respond(res, 200, sync({}));
			} else if (p === `${inst}/state` && m === "GET") {
				respond(res, 200, sync(runningWithAddress("10.200.0.50")));
			} else if (p === `${inst}/exec`) {
				respond(res, 200, sync({ metadata: { return: 0 } }));
			} else if (p === `${inst}/files` && m === "GET") {
				if (url.searchParams.get("path") !== "/etc/docker") return notFound();
				res.writeHead(200, { "X-Incus-type": "directory" });
				res.end("");
			} else if (p === `${inst}/files`) {
				if (m === "DELETE") return notFound();
				respond(res, 200, sync({}));
			} else if (p === vol && m === "POST") {
				b.volumes.add(JSON.parse(body).name);
				respond(res, 200, sync({}));
			} else if (p.startsWith(`${vol}/`)) {
				const rest = decodeURIComponent(p.slice(vol.length + 1));
				const name = rest.replace(/\/state$/, "");
				if (!b.volumes.has(name)) return notFound();
				if (rest.endsWith("/state")) {
					respond(res, 200, sync({ usage: { used: b.used } }));
				} else if (m === "GET") {
					respond(res, 200, sync({ name, config: {}, used_by: b.usedBy }));
				} else if (m === "DELETE") {
					b.volumes.delete(name);
					respond(res, 200, sync({}));
				} else if (m === "POST") {
					if (name === b.failRename) return incusError(res, 500, "rename failed");
					b.volumes.delete(name);
					b.volumes.add(JSON.parse(body).name);
					respond(res, 200, sync({}));
				} else {
					respond(res, 200, sync({}));
				}
			} else if (p === "/1.0/images/aliases/portikus") {
				respond(res, 200, sync({ target: "fp1" }));
			} else if (p === "/1.0/images/fp1") {
				respond(res, 200, sync({ properties: { serial: "2026.09.15" } }));
			} else {
				incusError(res, 404, `unexpected ${m} ${p}`);
			}
		};
		return b;
	}

	test("the builder is an ordinary workspace container with only a fresh Docker volume", async () => {
		const b = serveBuilder();
		await provider.prepareSeedBuilder({ maxBytes: 8 * 1024 ** 3, ghcr: false });
		const [create] = (b.bodies.get("POST /1.0/instances") ?? []) as Array<
			Record<string, unknown>
		>;
		expect(create).toEqual({
			name: SEED_BUILDER,
			source: { type: "image", alias: "portikus" },
			profiles: ["workspace"],
			devices: {
				docker: {
					type: "disk",
					pool: "mypool",
					source: SEED_BUILD_VOLUME,
					path: "/var/lib/docker",
				},
			},
		});
		// Nothing loosens the profile: no privileged or nesting keys of its own.
		expect(create).not.toHaveProperty("config");
		const [volume] =
			b.bodies.get("POST /1.0/storage-pools/mypool/volumes/custom") ?? [];
		// Shifted before the builder writes, so copies show real owners, not nobody.
		expect(volume).toEqual({
			name: SEED_BUILD_VOLUME,
			config: { size: "9GiB", "security.shifted": "true" },
		});
	});

	test("the builder gets the Hub mirror before it starts, and dockerd must answer", async () => {
		const b = serveBuilder();
		await provider.prepareSeedBuilder({ maxBytes: 8 * 1024 ** 3, ghcr: false });
		const push = b.log.indexOf(
			`POST /1.0/instances/${SEED_BUILDER}/files?/etc/docker/daemon.json`,
		);
		const start = b.log.indexOf(`PUT /1.0/instances/${SEED_BUILDER}/state`, 2);
		expect(push).toBeGreaterThan(0);
		expect(push).toBeLessThan(start);
		const execs = b.bodies.get(`POST /1.0/instances/${SEED_BUILDER}/exec`) as Array<{
			command: string[];
		}>;
		expect(execs.at(-1)?.command).toEqual(["/usr/bin/docker", "info"]);
	});

	test("a builder left by an earlier build is removed first", async () => {
		const b = serveBuilder();
		b.exists = true;
		b.volumes.add(SEED_BUILD_VOLUME);
		await provider.prepareSeedBuilder({ maxBytes: 1024 ** 3, ghcr: false });
		expect(b.log.slice(0, 3)).toEqual([
			`PUT /1.0/instances/${SEED_BUILDER}/state`,
			`DELETE /1.0/instances/${SEED_BUILDER}`,
			`DELETE /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		]);
	});

	test("commands run with no shell, one argument each", async () => {
		const b = serveBuilder();
		b.exists = true;
		expect(
			await provider.execInSeedBuilder(["/usr/bin/docker", "pull", "python:3.12"], 60),
		).toBe(0);
		const [exec] = b.bodies.get(`POST /1.0/instances/${SEED_BUILDER}/exec`) as Array<{
			command: string[];
		}>;
		expect(exec?.command).toEqual(["/usr/bin/docker", "pull", "python:3.12"]);
	});

	test("finish measures the volume, then stops and deletes the builder", async () => {
		const b = serveBuilder();
		b.exists = true;
		b.volumes.add(SEED_BUILD_VOLUME);
		expect(await provider.finishSeedBuilder()).toBe(3 * 1024 ** 3);
		const measured = b.log.indexOf(
			`GET /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}/state`,
		);
		expect(measured).toBe(0);
		expect(b.exists).toBe(false);
	});

	test("install puts the old seed back when the new one cannot take its name (F5)", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		b.failRename = SEED_BUILD_VOLUME;
		await expect(
			provider.installSeed({
				images: ["node:22"],
				sizeBytes: 5,
				imageVersion: "x",
				builtAt: "2026-09-30T12:00:00.000Z",
			}),
		).rejects.toThrow();
		expect(b.volumes.has("portikus-docker-seed")).toBe(true);
		expect(b.volumes.has(SEED_OLD_VOLUME)).toBe(false);
	});

	test("install stores its info on the volume and swaps it in for the old seed", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		const info = {
			images: ["node:22"],
			sizeBytes: 5,
			imageVersion: "2026.09.15",
			builtAt: "2026-09-30T12:00:00.000Z",
		};
		await provider.installSeed(info);
		const [patch] = b.bodies.get(
			`PATCH /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		) as Array<{ config: Record<string, string> }>;
		expect(JSON.parse(patch?.config[SEED_INFO_KEY] ?? "")).toEqual(info);
		expect([...b.volumes]).toEqual(["portikus-docker-seed"]);
		const renames = b.log.filter((l) => l.startsWith("POST /1.0/storage-pools"));
		expect(renames).toEqual([
			"POST /1.0/storage-pools/mypool/volumes/custom/portikus-docker-seed",
			`POST /1.0/storage-pools/mypool/volumes/custom/${SEED_BUILD_VOLUME}`,
		]);
		expect(b.log.at(-1)).toBe(
			`DELETE /1.0/storage-pools/mypool/volumes/custom/${SEED_OLD_VOLUME}`,
		);
	});

	test("install refuses a build volume anything still uses (S4)", async () => {
		const b = serveBuilder();
		b.volumes.add(SEED_BUILD_VOLUME);
		b.volumes.add("portikus-docker-seed");
		b.usedBy = [`/1.0/instances/${SEED_BUILDER}`];
		await expect(
			provider.installSeed({
				images: ["node:22"],
				sizeBytes: 5,
				imageVersion: "x",
				builtAt: "2026-09-30T12:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(VolumeInUseError);
		expect(b.log.some((l) => l.startsWith("PATCH") || l.startsWith("POST"))).toBe(
			false,
		);
	});

	test("the image version is the default image's serial", async () => {
		serveBuilder();
		expect(await provider.seedImageVersion()).toBe("2026.09.15");
	});
});
