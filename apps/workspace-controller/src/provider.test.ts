import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { IncusClient } from "./incus.js";
import { AGENT_HEALTH_TIMEOUT_MS, IncusWorkspaceProvider } from "./provider.js";

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
		agentPort,
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
		"export PORTIKUS_PREVIEW=true\nexport PORTIKUS_PREVIEW_HOST_SUFFIX=preview.portikus.example.edu\nexport TZ=America/New_York\n",
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
		provider.create("ws-test", { homeGiB: 25, dockerGiB: 20 }),
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
