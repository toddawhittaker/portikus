import type { ApiConfig } from "@portikus/config";
import {
	type AgentListeningService,
	MAX_LISTENING_SERVICES,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { AgentCallError } from "../agent-client.js";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import {
	createListeningRegistry,
	createProbeGuard,
	PROBE_MEMO_MS,
} from "./registry.js";

/**
 * The registry's poll opens one agent socket per running workspace. Two polls
 * at once would each decide the same workspace needs an entry, and the second
 * would overwrite the first, leaving its socket open with nothing holding it
 * (BROWSER-HANDLING.md §11.1).
 */
test("a slow poll is not joined by the next tick", async () => {
	let running = 0;
	let mostAtOnce = 0;
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	// Only the one query the poll makes is needed, so the database is a stub.
	const db = {
		selectFrom: () => ({
			select: () => ({
				where: () => ({
					execute: async () => {
						running += 1;
						mostAtOnce = Math.max(mostAtOnce, running);
						await gate;
						running -= 1;
						return [];
					},
				}),
			}),
		}),
	} as unknown as Kysely<Database>;

	const registry = createListeningRegistry({
		db,
		config: { AGENT_PORT: 7300 } as unknown as ApiConfig,
		logger: collectingLogger().logger,
		pollIntervalMs: 1,
	});

	registry.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(mostAtOnce).toBe(1);
	release();
	await registry.stop();
});

/**
 * A workspace may hold at most eight loopback forwards at once
 * (BROWSER-HANDLING.md §11.1, SPEC.md §24.7). A page inside a preview can ask
 * the bridge for many ports at once, so the cap has to hold when the calls
 * overlap, not only when they arrive one after another.
 */
test("concurrent calls cannot open more forwards than the cap", async () => {
	const AGENT_TOKEN = "registry-cap-token";
	const WORKSPACE = "11111111-1111-4111-8111-111111111111";
	let agent: FakeAgent | null = null;
	agent = await startFakeAgent(AGENT_TOKEN);

	const ports = [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];
	await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: WORKSPACE,
			services: ports.map((port) => ({
				port,
				addresses: ["127.0.0.1"],
				previewReachability: "unknown",
			})),
		}),
	});

	const rows = [
		{
			id: WORKSPACE,
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${WORKSPACE}`,
		},
	];
	const db = {
		selectFrom: () => ({
			select: () => ({ where: () => ({ execute: async () => rows }) }),
		}),
	} as unknown as Kysely<Database>;

	const registry = createListeningRegistry({
		db,
		config: {
			AGENT_PORT: agent.port,
			PREVIEW_PORT_MIN: 1,
			PREVIEW_PORT_MAX: 65535,
			previewDeniedPorts: [],
		} as unknown as ApiConfig,
		logger: collectingLogger().logger,
		pollIntervalMs: 5,
	});
	registry.start();

	// Wait until the registry has the agent's list.
	const deadline = Date.now() + 5000;
	while (registry.services(WORKSPACE).length < ports.length) {
		if (Date.now() > deadline) throw new Error("the registry never saw the list");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	const results = await Promise.allSettled(
		ports.map((port) => registry.ensureReachable(WORKSPACE, port)),
	);
	const opened = results.filter((one) => one.status === "fulfilled").length;
	expect(opened).toBe(8);
	expect(agent.forwards.get(WORKSPACE)?.size ?? 0).toBe(8);

	await registry.stop();
	await agent.close();
});

/**
 * The TLS probe guard. The authorize route has no rate limit, so
 * a failing agent may cost the API one call per port per memo window, and an
 * unsettled answer (the socket was replaced mid-probe) must not stick.
 */
function answer(protocolKnown: boolean | undefined): AgentListeningService {
	return {
		port: 5173,
		addresses: ["127.0.0.1"],
		previewReachability: "reachable",
		protocolHint: "http",
		...(protocolKnown === undefined ? {} : { protocolKnown }),
	} as AgentListeningService;
}

test("an unsettled probe answer is not final, so the next request probes again", async () => {
	let calls = 0;
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => {
			calls += 1;
			return answer(calls !== 1);
		},
	});
	vi.useFakeTimers();
	try {
		expect(await guard.probe("ws", 5173)).toBeNull();
		await vi.advanceTimersByTimeAsync(PROBE_MEMO_MS);
		expect((await guard.probe("ws", 5173))?.protocolKnown).toBe(true);
		expect(calls).toBe(2);
	} finally {
		vi.useRealTimers();
	}
});

test("an answer without protocolKnown is not treated as final", async () => {
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => answer(undefined),
	});
	expect(await guard.probe("ws", 5173)).toBeNull();
});

test("a failed probe is not retried within the memo window, then is", async () => {
	let calls = 0;
	const { logger, lines } = collectingLogger("debug");
	const guard = createProbeGuard({
		logger,
		probe: async () => {
			calls += 1;
			throw new AgentCallError("AGENT_UNAVAILABLE", "down");
		},
	});
	vi.useFakeTimers();
	try {
		expect(await guard.probe("ws", 5173)).toBeNull();
		await vi.advanceTimersByTimeAsync(PROBE_MEMO_MS - 1);
		expect(await guard.probe("ws", 5173)).toBeNull();
		expect(calls).toBe(1);
		expect(lines.filter((one) => one.msg === "protocol probe failed")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await guard.probe("ws", 5173);
		expect(calls).toBe(2);
		// Another port has its own memo.
		await guard.probe("ws", 3000);
		expect(calls).toBe(3);
	} finally {
		vi.useRealTimers();
	}
});

test("a final answer is memoised, so re-reporting the port unprobed cannot force probes", async () => {
	let calls = 0;
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => {
			calls += 1;
			return answer(true);
		},
	});
	vi.useFakeTimers();
	try {
		expect((await guard.probe("ws", 5173))?.protocolKnown).toBe(true);
		expect((await guard.probe("ws", 5173))?.protocolKnown).toBe(true);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(PROBE_MEMO_MS);
		await guard.probe("ws", 5173);
		expect(calls).toBe(2);
	} finally {
		vi.useRealTimers();
	}
});

test("forget drops one workspace's memo and expired keys are swept", async () => {
	let calls = 0;
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => {
			calls += 1;
			return answer(true);
		},
	});
	vi.useFakeTimers();
	try {
		await guard.probe("ws", 5173);
		await guard.probe("ws", 3000);
		await guard.probe("other", 5173);
		expect(guard.memoSize()).toBe(3);
		guard.forget("ws");
		expect(guard.memoSize()).toBe(1);
		await guard.probe("ws", 5173);
		expect(calls).toBe(4);
		await vi.advanceTimersByTimeAsync(PROBE_MEMO_MS);
		await guard.probe("ws", 8080);
		// Only the fresh key survives the sweep.
		expect(guard.memoSize()).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("forgetPort drops only that port's memo", async () => {
	let calls = 0;
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => {
			calls += 1;
			return answer(true);
		},
	});
	await guard.probe("ws", 5173);
	await guard.probe("ws", 3000);
	guard.forgetPort("ws", 5173);
	expect(guard.memoSize()).toBe(1);
	await guard.probe("ws", 5173);
	await guard.probe("ws", 3000);
	expect(calls).toBe(3);
});

test("an old agent without the probe route logs at debug, not warn", async () => {
	const { logger, lines } = collectingLogger("debug");
	const guard = createProbeGuard({
		logger,
		probe: async () => {
			throw new AgentCallError("AGENT_UNAVAILABLE", "not found", 404);
		},
	});
	expect(await guard.probe("ws", 5173)).toBeNull();
	expect(lines.map((one) => one.level)).toEqual(["debug"]);
});

test("concurrent requests for one port share one probe call", async () => {
	let calls = 0;
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const guard = createProbeGuard({
		logger: collectingLogger().logger,
		probe: async () => {
			calls += 1;
			await gate;
			return answer(true);
		},
	});
	const results = Promise.all([
		guard.probe("ws", 5173),
		guard.probe("ws", 5173),
		guard.probe("ws", 5173),
	]);
	release();
	const settled = await results;
	expect(calls).toBe(1);
	expect(settled.every((one) => one?.protocolKnown === true)).toBe(true);
});

/** A registry watching one fake-agent workspace, for the frame tests below. */
async function watchedWorkspace(token: string, workspaceId: string) {
	const agent = await startFakeAgent(token);
	const rows = [
		{
			id: workspaceId,
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${token}:${workspaceId}`,
		},
	];
	const db = {
		selectFrom: () => ({
			select: () => ({ where: () => ({ execute: async () => rows }) }),
		}),
	} as unknown as Kysely<Database>;
	const registry = createListeningRegistry({
		db,
		config: {
			AGENT_PORT: agent.port,
			PREVIEW_PORT_MIN: 1,
			PREVIEW_PORT_MAX: 65535,
			previewDeniedPorts: [],
		} as unknown as ApiConfig,
		logger: collectingLogger().logger,
		pollIntervalMs: 5,
	});
	const seed = async (services: Partial<AgentListeningService>[]): Promise<void> => {
		await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: workspaceId, services }),
		});
	};
	const until = async (check: () => boolean): Promise<void> => {
		const deadline = Date.now() + 5000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("the registry never caught up");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const close = async (): Promise<void> => {
		await registry.stop();
		await agent.close();
	};
	return { agent, registry, seed, until, close };
}

/**
 * A replaced agent can send any frame it likes (SPEC.md §24). A list longer
 * than MAX_LISTENING_SERVICES is dropped whole, the last good list stays, and
 * the socket stays open so the next honest frame still lands.
 */
test("an over-long services frame is dropped and the previous list kept", async () => {
	const WORKSPACE = "22222222-2222-4222-8222-222222222222";
	const { registry, seed, until, close } = await watchedWorkspace(
		"registry-max",
		WORKSPACE,
	);
	const ports = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ port: 1024 + index }));
	try {
		await seed(ports(2));
		registry.start();
		await until(() => registry.services(WORKSPACE).length === 2);

		await seed(ports(MAX_LISTENING_SERVICES + 1));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(registry.services(WORKSPACE)).toHaveLength(2);

		await seed(ports(MAX_LISTENING_SERVICES));
		await until(() => registry.services(WORKSPACE).length === MAX_LISTENING_SERVICES);
	} finally {
		await close();
	}
});

/**
 * A server restarted on the same port is a new socket the agent has not
 * probed, and it often keeps the same port-number guess. The memoised
 * answer for the old server must not stand in for it.
 */
test("a known listener relisted as unknown with the same hint is probed again", async () => {
	const WORKSPACE = "44444444-4444-4444-8444-444444444444";
	const { agent, registry, seed, until, close } = await watchedWorkspace(
		"registry-reprobe",
		WORKSPACE,
	);
	try {
		await seed([{ port: 5173, protocolHint: "http" }]);
		registry.start();
		await until(() => registry.services(WORKSPACE).length === 1);
		await registry.serviceWithProtocol(WORKSPACE, 5173);
		await until(() => registry.service(WORKSPACE, 5173)?.protocolKnown === true);
		expect(agent.probes.get(WORKSPACE)).toHaveLength(1);

		await seed([{ port: 5173, protocolHint: "http" }]);
		await until(() => registry.service(WORKSPACE, 5173)?.protocolKnown !== true);
		await registry.serviceWithProtocol(WORKSPACE, 5173);
		expect(agent.probes.get(WORKSPACE)).toHaveLength(2);
	} finally {
		await close();
	}
});
