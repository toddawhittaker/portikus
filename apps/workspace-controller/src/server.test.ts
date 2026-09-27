import { HostSnapshot, InstanceUsageResponse } from "@portikus/contracts";
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
