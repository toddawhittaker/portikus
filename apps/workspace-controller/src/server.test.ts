import {
	HostSnapshot,
	InstanceProcessesResponse,
	InstanceUsageResponse,
} from "@portikus/contracts";
import type { LogLevel } from "@portikus/observability";
import { collectingLogger, lineAt } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeWorkspaceProvider } from "./fake-provider.js";
import { buildServer } from "./server.js";

const TOKEN = "test-token-value";
const AGENT_TOKEN = "a".repeat(64);
let provider: FakeWorkspaceProvider;
let app: FastifyInstance;

beforeEach(() => {
	provider = new FakeWorkspaceProvider();
	app = buildServer({ provider, token: TOKEN });
});

afterEach(async () => {
	await app.close();
});

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

// Auth tests.

test("401 without token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	expect(res.statusCode).toBe(401);
	expect(res.json().code).toBe("UNAUTHORIZED");
});

test("401 with wrong-length token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
		headers: { authorization: "Bearer short" },
	});
	expect(res.statusCode).toBe(401);
});

test("401 with wrong token of same length", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
		headers: { authorization: "Bearer wrong-token-valu" },
	});
	expect(res.statusCode).toBe(401);
});

test("GET /health does not require auth", async () => {
	const res = await app.inject({ method: "GET", url: "/health" });
	expect(res.statusCode).toBe(200);
	expect(res.json().service).toBe("workspace-controller");
});

test("a path that merely starts with /health still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/healthz" });
	// No such route, so it is a 404 rather than a pass through the exemption.
	expect(res.statusCode).not.toBe(200);
});

test("GET /instances still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/instances" });
	expect(res.statusCode).toBe(401);
});

// POST /instances

test("a full storage pool refuses a create with 507 POOL_FULL", async () => {
	provider.failNext("POOL_FULL");
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
		headers: auth(),
	});
	expect(res.statusCode).toBe(507);
	expect(res.json().code).toBe("POOL_FULL");
});

test("create instance happy path", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	expect(res.statusCode).toBe(201);
	expect(res.json().created).toBe(true);
});

test("create instance already exists returns 200", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().created).toBe(false);
});

test("create with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "INVALID!", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("INVALID_NAME");
});

// POST /instances/:name/start

test("start happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
		},
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().ipv4).toBe("10.0.0.2");
});

test("start passes the agent token through to the provider", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
		},
	});
	expect(provider.instances.get("ws-abc")?.agentToken).toBe(AGENT_TOKEN);
});

test("start passes the preview host suffix through to the provider", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
		},
	});
	expect(provider.instances.get("ws-abc")?.previewHostSuffix).toBe(
		"preview.example.edu",
	);
});

test("start without an agent token returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { timeoutSeconds: 10 },
	});
	expect(res.statusCode).toBe(400);
});

test("start not found returns 404", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-missing/start",
		headers: auth(),
		payload: {
			timeoutSeconds: 10,
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
		},
	});
	expect(res.statusCode).toBe(404);
});

test("start with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/BAD!/start",
		headers: auth(),
		payload: {},
	});
	expect(res.statusCode).toBe(400);
});

// POST /instances/:name/stop

test("stop happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: {
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
		},
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(false);
});

test("stop with forced path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	provider.setStopHangs(true);
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(true);
});

// GET /instances

test("list instances", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	const list = res.json();
	expect(list).toHaveLength(1);
	expect(list[0].name).toBe("ws-abc");
});

// Provider error mapping.

test("INCUS_UNAVAILABLE maps to 503", async () => {
	provider.failNext("INCUS_UNAVAILABLE");
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(503);
});

// Single-flight.

test("two concurrent starts cause one provider call", async () => {
	let startCount = 0;
	const original = provider.start.bind(provider);
	provider.start = async (name, opts) => {
		startCount++;
		// Add a small delay to ensure both requests arrive.
		await new Promise((r) => setTimeout(r, 50));
		return original(name, opts);
	};

	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});

	const [r1, r2] = await Promise.all([
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: {
				timeoutSeconds: 10,
				agentToken: AGENT_TOKEN,
				hostname: "tw7",
				previewHostSuffix: "preview.example.edu",
				timezone: "America/New_York",
			},
		}),
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: {
				timeoutSeconds: 10,
				agentToken: AGENT_TOKEN,
				hostname: "tw7",
				previewHostSuffix: "preview.example.edu",
				timezone: "America/New_York",
			},
		}),
	]);

	expect(r1.statusCode).toBe(200);
	expect(r2.statusCode).toBe(200);
	expect(startCount).toBe(1);
});

// Logging (ADR 0012).

function buildLogging(level: LogLevel = "info") {
	const { logger, lines } = collectingLogger(level);
	const logged = buildServer({ provider, token: TOKEN, logger });
	return {
		logged,
		logger,
		lines,
		requests: () => lines.filter((l) => l.msg === "request"),
	};
}

test("PUT /log-level changes the level the controller logs at", async () => {
	// The level has to land on the logger index.ts made, not on Fastify's child
	// of it, or the controller's and provider's own debug lines stay silent.
	const { logged, logger, lines } = buildLogging("info");
	try {
		const res = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		expect(res.statusCode).toBe(204);
		expect(logger.level).toBe("debug");
		expect(lines.some((l) => l.msg === "log level changed" && l.to === "debug")).toBe(
			true,
		);

		// A line logged through the root logger, outside any request, as the
		// provider's polling line is.
		lines.length = 0;
		logger.debug({ attempt: 1 }, "polling the workspace agent");
		expect(lines).toHaveLength(1);
		expect(lineAt(lines, 0).msg).toBe("polling the workspace agent");

		const cleared = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("info");
		lines.length = 0;
		logger.debug({ attempt: 2 }, "polling the workspace agent");
		expect(lines).toHaveLength(0);
	} finally {
		await logged.close();
	}
});

test("PUT /log-level needs the token and a known level", async () => {
	const { logged, logger } = buildLogging();
	try {
		const noToken = await logged.inject({
			method: "PUT",
			url: "/log-level",
			payload: { level: "debug" },
		});
		expect(noToken.statusCode).toBe(401);

		const bad = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "verbose" },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe("BAD_REQUEST");
		expect(logger.level).toBe("info");
	} finally {
		await logged.close();
	}
});

test("a null level returns the controller to the level it started with", async () => {
	const { logged, logger } = buildLogging("warn");
	try {
		await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		expect(logger.level).toBe("debug");

		const cleared = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("warn");
	} finally {
		await logged.close();
	}
});

test("a request logs one line, and an Incus failure names the reason", async () => {
	const { logged, requests } = buildLogging();
	try {
		const ok = await logged.inject({
			method: "GET",
			url: "/instances",
			headers: auth(),
		});
		expect(ok.statusCode).toBe(200);
		expect(requests()[0]?.level).toBe("info");

		provider.failNext("INCUS_UNAVAILABLE");
		const failed = await logged.inject({
			method: "POST",
			url: "/instances",
			headers: auth(),
			payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
		});
		expect(failed.statusCode).toBe(503);
		const line = requests()[1];
		expect(line?.level).toBe("error");
		expect(line?.code).toBe("INCUS_UNAVAILABLE");
		expect(line?.error).toBe("fake error: INCUS_UNAVAILABLE");
	} finally {
		await logged.close();
	}
});

// Maintenance operations (ADR 0021).

async function createStopped(name = "ws-abc") {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name, homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 },
	});
}

test("create and start pass the recovery size to the provider", async () => {
	await createStopped();
	expect(provider.instances.get("ws-abc")?.recoveryGiB).toBe(3);

	const calls: Array<number | undefined> = [];
	const original = provider.start.bind(provider);
	provider.start = async (name, opts) => {
		calls.push(opts.recoveryGiB);
		return original(name, opts);
	};
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: {
			agentToken: AGENT_TOKEN,
			hostname: "tw7",
			previewHostSuffix: "preview.example.edu",
			timezone: "America/New_York",
			recoveryGiB: 4,
		},
	});
	expect(calls).toEqual([4]);
});

test("reset-docker on a stopped instance answers 204 and replaces the volume", async () => {
	await createStopped();
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/reset-docker",
		headers: auth(),
		payload: { dockerGiB: 30 },
	});
	expect(res.statusCode).toBe(204);
	const inst = provider.instances.get("ws-abc");
	expect(inst?.dockerGeneration).toBe(2);
	expect(inst?.quota.dockerGiB).toBe(30);
});

test("reset-docker and rebuild answer 409 while the instance runs", async () => {
	await createStopped();
	const inst = provider.instances.get("ws-abc");
	if (!inst) throw new Error("expected the instance");
	inst.status = "Running";

	const reset = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/reset-docker",
		headers: auth(),
		payload: { dockerGiB: 20 },
	});
	const rebuild = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/rebuild",
		headers: auth(),
		payload: { resetDocker: false, dockerGiB: 20 },
	});
	expect(reset.statusCode).toBe(409);
	expect(rebuild.statusCode).toBe(409);
	expect(rebuild.json().message).toContain("stop it first");
	expect(inst.dockerGeneration).toBe(1);
	expect(inst.rebuilds).toBe(0);
});

test("rebuild answers the new image fingerprint", async () => {
	await createStopped();
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/rebuild",
		headers: auth(),
		payload: { resetDocker: true, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({ imageFingerprint: "def456" });
	const inst = provider.instances.get("ws-abc");
	expect(inst?.rebuilds).toBe(1);
	expect(inst?.dockerGeneration).toBe(2);
});

test("maintenance routes check the name, the body, and the token", async () => {
	await createStopped();
	const badName = await app.inject({
		method: "POST",
		url: "/instances/BAD!/rebuild",
		headers: auth(),
		payload: { resetDocker: false, dockerGiB: 20 },
	});
	expect(badName.statusCode).toBe(400);
	expect(badName.json().code).toBe("INVALID_NAME");

	const badBody = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/reset-docker",
		headers: auth(),
		payload: { dockerGiB: -1 },
	});
	expect(badBody.statusCode).toBe(400);
	expect(badBody.json().code).toBe("BAD_REQUEST");

	const noRebuildFlag = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/rebuild",
		headers: auth(),
		payload: { dockerGiB: 20 },
	});
	expect(noRebuildFlag.statusCode).toBe(400);

	const noToken = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/reset-docker",
		payload: { dockerGiB: 20 },
	});
	expect(noToken.statusCode).toBe(401);

	const missing = await app.inject({
		method: "POST",
		url: "/instances/ws-nope/reset-docker",
		headers: auth(),
		payload: { dockerGiB: 20 },
	});
	expect(missing.statusCode).toBe(404);
});

test("two concurrent resets cause one provider call", async () => {
	await createStopped();
	let resets = 0;
	const original = provider.resetDocker.bind(provider);
	provider.resetDocker = async (name, opts) => {
		resets++;
		await new Promise((r) => setTimeout(r, 50));
		return original(name, opts);
	};
	const request = () =>
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/reset-docker",
			headers: auth(),
			payload: { dockerGiB: 20 },
		});
	const [a, b] = await Promise.all([request(), request()]);
	expect(a.statusCode).toBe(204);
	expect(b.statusCode).toBe(204);
	expect(resets).toBe(1);
});

test("two concurrent rebuilds cause one provider call", async () => {
	await createStopped();
	let rebuilds = 0;
	const original = provider.rebuild.bind(provider);
	provider.rebuild = async (name, opts) => {
		rebuilds++;
		await new Promise((r) => setTimeout(r, 50));
		return original(name, opts);
	};
	const request = () =>
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/rebuild",
			headers: auth(),
			payload: { resetDocker: false, dockerGiB: 20 },
		});
	const [a, b] = await Promise.all([request(), request()]);
	expect(a.statusCode).toBe(200);
	expect(b.json()).toEqual({ imageFingerprint: "def456" });
	expect(rebuilds).toBe(1);
});

// Host snapshot and volume grow (Epic 11 task 2).

test("GET /host needs the token", async () => {
	const res = await app.inject({ method: "GET", url: "/host" });
	expect(res.statusCode).toBe(401);
});

test("GET /host returns the provider's snapshot", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	const res = await app.inject({ method: "GET", url: "/host", headers: auth() });
	expect(res.statusCode).toBe(200);
	const body = HostSnapshot.parse(res.json());
	expect(body.image.serial).toBe("2026.09.9");
	expect(body.instances.map((i) => i.name)).toEqual(["ws-abc"]);
});

test("GET /host maps an Incus failure to its status", async () => {
	provider.failNext("INCUS_UNAVAILABLE");
	const res = await app.inject({ method: "GET", url: "/host", headers: auth() });
	expect(res.statusCode).toBe(503);
	expect(res.json().code).toBe("INCUS_UNAVAILABLE");
});

test("POST /instances/:name/volumes needs the token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/volumes",
		payload: { homeGiB: 30, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(401);
});

test("POST /instances/:name/volumes grows the volumes", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/volumes",
		headers: auth(),
		payload: { homeGiB: 30, dockerGiB: 40 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({ homeGiB: 30, dockerGiB: 40 });
	expect(provider.instances.get("ws-abc")?.quota).toEqual({
		homeGiB: 30,
		dockerGiB: 40,
	});
});

test("POST /instances/:name/volumes refuses a shrink with 400", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/volumes",
		headers: auth(),
		payload: { homeGiB: 24, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(400);
	expect(res.json()).toEqual({
		code: "BAD_REQUEST",
		message: "Storage can only be increased.",
	});
	expect(provider.instances.get("ws-abc")?.quota).toEqual({
		homeGiB: 25,
		dockerGiB: 20,
	});
});

test("POST /instances/:name/volumes rejects a bad name, body, or unknown instance", async () => {
	const badName = await app.inject({
		method: "POST",
		url: "/instances/Bad_Name/volumes",
		headers: auth(),
		payload: { homeGiB: 30, dockerGiB: 20 },
	});
	expect(badName.statusCode).toBe(400);
	expect(badName.json().code).toBe("INVALID_NAME");

	const badBody = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/volumes",
		headers: auth(),
		payload: { homeGiB: 2000, dockerGiB: 20 },
	});
	expect(badBody.statusCode).toBe(400);
	expect(badBody.json().code).toBe("BAD_REQUEST");

	const missing = await app.inject({
		method: "POST",
		url: "/instances/ws-nope/volumes",
		headers: auth(),
		payload: { homeGiB: 30, dockerGiB: 20 },
	});
	expect(missing.statusCode).toBe(404);
});

// Resource guard routes (ADR 0032).

const START_BODY = {
	timeoutSeconds: 10,
	agentToken: AGENT_TOKEN,
	hostname: "tw7",
	previewHostSuffix: "preview.example.edu",
	timezone: "UTC",
};

test("the usage and allowance routes need the token", async () => {
	const usage = await app.inject({ method: "GET", url: "/instances/usage" });
	expect(usage.statusCode).toBe(401);
	const put = await app.inject({
		method: "PUT",
		url: "/instances/ws-abc/cpu-allowance",
		payload: { allowance: "100ms/100ms" },
	});
	expect(put.statusCode).toBe(401);
});

test("GET /instances/usage lists running instances in the contract shape", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	await provider.create("ws-off", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	await provider.start("ws-abc", START_BODY);

	const res = await app.inject({
		method: "GET",
		url: "/instances/usage",
		headers: auth(),
	});

	expect(res.statusCode).toBe(200);
	const body = InstanceUsageResponse.parse(res.json());
	expect(body.instances.map((i) => i.name)).toEqual(["ws-abc"]);
});

test("GET /instances/usage maps an Incus failure to its status", async () => {
	provider.failNext("INCUS_UNAVAILABLE");
	const res = await app.inject({
		method: "GET",
		url: "/instances/usage",
		headers: auth(),
	});
	expect(res.statusCode).toBe(503);
});

test("PUT /instances/:name/cpu-allowance sets and removes the allowance", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	await provider.start("ws-abc", START_BODY);

	const set = await app.inject({
		method: "PUT",
		url: "/instances/ws-abc/cpu-allowance",
		headers: auth(),
		payload: { allowance: "100ms/100ms" },
	});
	expect(set.statusCode).toBe(204);
	expect(provider.instances.get("ws-abc")?.cpuAllowance).toBe("100ms/100ms");

	const cleared = await app.inject({
		method: "PUT",
		url: "/instances/ws-abc/cpu-allowance",
		headers: auth(),
		payload: { allowance: null },
	});
	expect(cleared.statusCode).toBe(204);
	expect(provider.instances.get("ws-abc")?.cpuAllowance).toBeNull();
});

test("PUT /instances/:name/cpu-allowance refuses anything but a time slice", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	for (const payload of [
		{ allowance: "25%" },
		{ allowance: "0ms/100ms" },
		{ allowance: "100ms/200ms" },
		{ allowance: 100 },
		{},
		{ allowance: "100ms/100ms", extra: true },
	]) {
		const res = await app.inject({
			method: "PUT",
			url: "/instances/ws-abc/cpu-allowance",
			headers: auth(),
			payload,
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("BAD_REQUEST");
	}
	expect(provider.instances.get("ws-abc")?.cpuAllowance).toBeNull();

	const badName = await app.inject({
		method: "PUT",
		url: "/instances/Bad_Name/cpu-allowance",
		headers: auth(),
		payload: { allowance: "100ms/100ms" },
	});
	expect(badName.statusCode).toBe(400);
	expect(badName.json().code).toBe("INVALID_NAME");

	const missing = await app.inject({
		method: "PUT",
		url: "/instances/ws-nope/cpu-allowance",
		headers: auth(),
		payload: { allowance: "100ms/100ms" },
	});
	expect(missing.statusCode).toBe(404);
});

test("the fake's start clears an allowance, as the real one does", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	await provider.setCpuAllowance("ws-abc", "100ms/100ms");
	await provider.start("ws-abc", START_BODY);
	expect(provider.instances.get("ws-abc")?.cpuAllowance).toBeNull();
});

test("GET /instances/:name/processes answers the provider's rows", async () => {
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	await provider.start("ws-abc", START_BODY);
	const res = await app.inject({
		method: "GET",
		url: "/instances/ws-abc/processes",
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	expect(InstanceProcessesResponse.parse(res.json()).processes).toEqual(
		provider.processRows,
	);
});

test("GET /instances/:name/processes refuses bad names, unknown and stopped instances", async () => {
	const bad = await app.inject({
		method: "GET",
		url: "/instances/NOT_OK/processes",
		headers: auth(),
	});
	expect(bad.statusCode).toBe(400);
	const missing = await app.inject({
		method: "GET",
		url: "/instances/ws-none/processes",
		headers: auth(),
	});
	expect(missing.statusCode).toBe(404);
	await provider.create("ws-abc", { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	const stopped = await app.inject({
		method: "GET",
		url: "/instances/ws-abc/processes",
		headers: auth(),
	});
	expect(stopped.statusCode).toBe(500);
	const anonymous = await app.inject({
		method: "GET",
		url: "/instances/ws-abc/processes",
	});
	expect(anonymous.statusCode).toBe(401);
});

// Admin operations (SPEC.md §19.3, §20.1): limits, the package list, kept
// volumes and Replace home.

const WS = "ws-0123456789abcdef01234567";

async function createWs(): Promise<void> {
	await provider.create(WS, { homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
}

test("every new route needs the token", async () => {
	for (const [method, url] of [
		["PUT", `/instances/${WS}/limits`],
		["GET", `/instances/${WS}/added-packages`],
		["GET", "/volumes/kept"],
		["DELETE", `/volumes/${WS}-home/snapshots/pre-x`],
		["DELETE", `/volumes/${WS}-home-replaced-1`],
		["POST", `/instances/${WS}/replace-home`],
	] as const) {
		const res = await app.inject({ method, url });
		expect(res.statusCode, `${method} ${url}`).toBe(401);
	}
});

test("PUT /instances/:name/limits sets and removes each limit", async () => {
	await createWs();
	const res = await app.inject({
		method: "PUT",
		url: `/instances/${WS}/limits`,
		headers: auth(),
		payload: { cpu: 2, memoryMiB: 4096, processes: null },
	});
	expect(res.statusCode).toBe(204);
	expect(provider.instances.get(WS)?.limits).toEqual({
		cpu: 2,
		memoryMiB: 4096,
		processes: null,
	});
});

test("limits refuses more CPUs than the host has, and values out of range", async () => {
	await createWs();
	const tooMany = await app.inject({
		method: "PUT",
		url: `/instances/${WS}/limits`,
		headers: auth(),
		payload: { cpu: provider.hostCpuCount + 1, memoryMiB: null, processes: null },
	});
	expect(tooMany.statusCode).toBe(400);
	expect(tooMany.json().code).toBe("BAD_REQUEST");

	for (const payload of [
		{ cpu: 0, memoryMiB: null, processes: null },
		{ cpu: null, memoryMiB: 511, processes: null },
		{ cpu: null, memoryMiB: null, processes: 32769 },
		{ cpu: null, memoryMiB: null },
		{ cpu: null, memoryMiB: null, processes: null, extra: 1 },
	]) {
		const res = await app.inject({
			method: "PUT",
			url: `/instances/${WS}/limits`,
			headers: auth(),
			payload,
		});
		expect(res.statusCode, JSON.stringify(payload)).toBe(400);
	}
	const badName = await app.inject({
		method: "PUT",
		url: "/instances/Bad_Name/limits",
		headers: auth(),
		payload: { cpu: 1, memoryMiB: null, processes: null },
	});
	expect(badName.json().code).toBe("INVALID_NAME");
	expect(provider.instances.get(WS)?.limits.cpu).toBeNull();
});

test("start with an allowance leaves the instance throttled; without one it is cleared", async () => {
	await createWs();
	const body = {
		agentToken: AGENT_TOKEN,
		hostname: "tw7",
		previewHostSuffix: "preview.example.edu",
		timezone: "America/New_York",
	};
	const held = await app.inject({
		method: "POST",
		url: `/instances/${WS}/start`,
		headers: auth(),
		payload: { ...body, cpuAllowance: "50ms/100ms" },
	});
	expect(held.statusCode).toBe(200);
	expect(provider.instances.get(WS)?.cpuAllowance).toBe("50ms/100ms");

	await provider.stop(WS, { timeoutSeconds: 1 });
	await app.inject({
		method: "POST",
		url: `/instances/${WS}/start`,
		headers: auth(),
		payload: body,
	});
	expect(provider.instances.get(WS)?.cpuAllowance).toBeNull();

	const bad = await app.inject({
		method: "POST",
		url: `/instances/${WS}/start`,
		headers: auth(),
		payload: { ...body, cpuAllowance: "50%" },
	});
	expect(bad.statusCode).toBe(400);
});

test("GET /instances/:name/added-packages returns the checked list", async () => {
	await createWs();
	const inst = provider.instances.get(WS);
	if (!inst) throw new Error("no instance");
	inst.addedPackagesFile = {
		type: "file",
		content:
			"# portikus-image: 2026.09.9\nhtop\n\nrm -rf /\nlibfoo2:amd64\npython3.13-venv\nhtop\n",
	};
	const res = await app.inject({
		method: "GET",
		url: `/instances/${WS}/added-packages`,
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({
		image: "2026.09.9",
		packages: ["htop", "python3.13-venv"],
	});
});

test("added-packages answers 404 for a missing file or a symbolic link, and refuses an oversized one", async () => {
	await createWs();
	const inst = provider.instances.get(WS);
	if (!inst) throw new Error("no instance");
	const get = () =>
		app.inject({
			method: "GET",
			url: `/instances/${WS}/added-packages`,
			headers: auth(),
		});

	expect((await get()).statusCode).toBe(404);
	inst.addedPackagesFile = { type: "symlink", content: "/etc/shadow" };
	const link = await get();
	expect(link.statusCode).toBe(404);
	expect(link.json().code).toBe("NOT_FOUND");
	inst.addedPackagesFile = { type: "file", content: "a".repeat(64 * 1024 + 1) };
	expect((await get()).statusCode).toBe(400);
});

test("GET /volumes/kept lists only pre-change snapshots and kept homes", async () => {
	await createWs();
	provider.volumes
		.get(`${WS}-home`)
		?.snapshots.set("pre-upgrade", "2026-09-24T02:30:00Z");
	provider.volumes
		.get(`${WS}-home`)
		?.snapshots.set("portikus-backup", "2026-09-24T02:00:00Z");
	provider.addVolume(`${WS}-home-replaced-1790000000`, "2026-09-25T00:00:00Z");
	provider.addVolume("something-else");

	const res = await app.inject({
		method: "GET",
		url: "/volumes/kept",
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({
		snapshots: [
			{ volume: `${WS}-home`, name: "pre-upgrade", createdAt: "2026-09-24T02:30:00Z" },
		],
		keptHomes: [
			{
				volume: `${WS}-home-replaced-1790000000`,
				instance: WS,
				createdAt: "2026-09-25T00:00:00Z",
			},
		],
	});
});

test("DELETE a snapshot deletes only pre-change snapshots on workspace volumes", async () => {
	await createWs();
	const snaps = provider.volumes.get(`${WS}-home`)?.snapshots;
	snaps?.set("pre-upgrade", "t");
	snaps?.set("portikus-backup", "t");

	for (const url of [
		`/volumes/${WS}-home/snapshots/portikus-backup`,
		`/volumes/${WS}-home/snapshots/pre-`,
		`/volumes/${WS}-home/snapshots/pre-UP`,
		`/volumes/${WS}-home-replaced-1/snapshots/pre-upgrade`,
		`/volumes/${WS}-other/snapshots/pre-upgrade`,
		"/volumes/ws-abc-home/snapshots/pre-upgrade",
		`/volumes/..%2F${WS}-home/snapshots/pre-upgrade`,
	]) {
		const res = await app.inject({ method: "DELETE", url, headers: auth() });
		expect(res.statusCode, url).toBe(400);
		expect(res.json().code).toBe("BAD_REQUEST");
	}
	expect([...(snaps?.keys() ?? [])]).toEqual(["pre-upgrade", "portikus-backup"]);

	const ok = await app.inject({
		method: "DELETE",
		url: `/volumes/${WS}-home/snapshots/pre-upgrade`,
		headers: auth(),
	});
	expect(ok.statusCode).toBe(204);
	expect([...(snaps?.keys() ?? [])]).toEqual(["portikus-backup"]);
});

test("DELETE a volume deletes only kept homes", async () => {
	await createWs();
	provider.addVolume(`${WS}-home-replaced-1790000000`);
	for (const url of [
		`/volumes/${WS}-home`,
		`/volumes/${WS}-docker`,
		`/volumes/${WS}-home-import`,
		`/volumes/${WS}-home-replaced-`,
		`/volumes/${WS}-home-replaced-12x`,
	]) {
		const res = await app.inject({ method: "DELETE", url, headers: auth() });
		expect(res.statusCode, url).toBe(400);
	}
	expect(provider.volumes.has(`${WS}-home`)).toBe(true);

	const ok = await app.inject({
		method: "DELETE",
		url: `/volumes/${WS}-home-replaced-1790000000`,
		headers: auth(),
	});
	expect(ok.statusCode).toBe(204);
	expect(provider.volumes.has(`${WS}-home-replaced-1790000000`)).toBe(false);
});

test("POST /instances/:name/replace-home swaps the import in and keeps the old home", async () => {
	await createWs();
	const oldHome = provider.volumes.get(`${WS}-home`);
	provider.addVolume(`${WS}-home-import`);
	const imported = provider.volumes.get(`${WS}-home-import`);

	const res = await app.inject({
		method: "POST",
		url: `/instances/${WS}/replace-home`,
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	const { kept } = res.json() as { kept: string };
	expect(kept).toMatch(new RegExp(`^${WS}-home-replaced-\\d+$`));
	expect(provider.volumes.get(kept)).toBe(oldHome);
	expect(provider.volumes.get(`${WS}-home`)).toBe(imported);
	expect(provider.volumes.has(`${WS}-home-import`)).toBe(false);
});

test("replace-home refuses a running instance and a missing import", async () => {
	await createWs();
	provider.addVolume(`${WS}-home-import`);
	await provider.start(WS, {
		timeoutSeconds: 1,
		agentToken: AGENT_TOKEN,
		hostname: "tw7",
		previewHostSuffix: "p.example.edu",
		timezone: "America/New_York",
	});
	const running = await app.inject({
		method: "POST",
		url: `/instances/${WS}/replace-home`,
		headers: auth(),
	});
	expect(running.statusCode).toBe(409);
	expect(provider.volumes.has(`${WS}-home-import`)).toBe(true);

	await provider.stop(WS, { timeoutSeconds: 1 });
	provider.volumes.delete(`${WS}-home-import`);
	const missing = await app.inject({
		method: "POST",
		url: `/instances/${WS}/replace-home`,
		headers: auth(),
	});
	expect(missing.statusCode).toBe(404);
});
