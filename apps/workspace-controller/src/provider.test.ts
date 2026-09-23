import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { IncusClient } from "./incus.js";
import {
	AGENT_HEALTH_TIMEOUT_MS,
	IncusWorkspaceProvider,
	InstanceNotStoppedError,
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
			respond(res, 200, sync({ metadata: { return: 1 } }));
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
			if (state.volumes.has(parsed.name)) {
				incusError(res, 409, "Volume by that name already exists");
				return;
			}
			state.createdVolumes.push(parsed.name);
			state.volumes.set(parsed.name, parsed.config.size);
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
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances/ws-test/state" && method === "GET") {
			respond(res, 200, sync(runningWithAddress("127.0.0.1")));
		} else if (p === "/1.0/instances/ws-test/exec") {
			state.execs.push(JSON.parse(body).command);
			respond(res, 200, sync({}));
		} else if (p === "/1.0/instances/ws-test/files") {
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
	// A new volume picks up the current quota (EPIC-10 risk 9).
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
