import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { createListeningRegistry, type ListeningRegistry } from "./registry.js";

/**
 * The agent's coding-agent states travel on the same socket as the listening
 * list. The agent is untrusted, so a bad frame must change nothing and leak
 * no content into the log.
 */
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const TERMINAL = "33333333-3333-4333-8333-333333333333";
const AGENT_TOKEN = "registry-agents-token";

interface Context {
	agent: FakeAgent;
	registry: ListeningRegistry;
	rows: Array<Record<string, unknown>>;
	lines: Record<string, unknown>[];
	setAgents: (terminals: unknown[]) => Promise<void>;
}

async function withRegistry(run: (context: Context) => Promise<void>): Promise<void> {
	const agent = await startFakeAgent(AGENT_TOKEN);
	const rows: Array<Record<string, unknown>> = [
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
	const { logger, lines } = collectingLogger("debug");
	const registry = createListeningRegistry({
		db,
		config: { AGENT_PORT: agent.port } as unknown as ApiConfig,
		logger,
		pollIntervalMs: 5,
	});
	const setAgents = async (terminals: unknown[]): Promise<void> => {
		const response = await fetch(
			`http://127.0.0.1:${agent.port}/__test/coding-agents`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: WORKSPACE, terminals }),
			},
		);
		expect(response.status).toBe(204);
	};
	registry.start();
	try {
		await run({ agent, registry, rows, lines, setAgents });
	} finally {
		await registry.stop();
		await agent.close();
	}
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("the registry keeps the last coding-agent list and tells subscribers", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		const seen: Array<number | null> = [];
		const unsubscribe = registry.subscribeCodingAgents(WORKSPACE, () => {
			seen.push(registry.codingAgents(WORKSPACE)?.length ?? null);
		});
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "working" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE)?.length === 1);
		expect(registry.codingAgents(WORKSPACE)?.[0]).toMatchObject({
			terminalId: TERMINAL,
			agent: "claude",
			state: "working",
		});
		await waitFor(() => seen.includes(1));

		unsubscribe();
		const before = seen.length;
		await setAgents([]);
		await waitFor(() => registry.codingAgents(WORKSPACE)?.length === 0);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(seen).toHaveLength(before);
	});
});

test("an invalid coding-agent frame is ignored and only field names are logged", async () => {
	await withRegistry(async ({ registry, lines, setAgents }) => {
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "working" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE)?.length === 1);

		await setAgents([
			{ terminalId: TERMINAL, agent: "claude", state: "SECRET-prompt-text" },
		]);
		await waitFor(() =>
			lines.some((line) => line.msg === "coding agents frame rejected"),
		);
		expect(registry.codingAgents(WORKSPACE)?.[0]?.state).toBe("working");
		const line = lines.find((one) => one.msg === "coding agents frame rejected");
		expect(line?.fields).toEqual(["terminals.0.state"]);
		expect(JSON.stringify(lines)).not.toContain("SECRET-prompt-text");

		// More than twenty terminals is invalid as a whole.
		await setAgents(
			Array.from({ length: 21 }, (_, i) => ({
				terminalId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				agent: "codex",
				state: "finished",
			})),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(registry.codingAgents(WORKSPACE)).toHaveLength(1);
	});
});

test("a workspace that drops notifies an empty coding-agent list", async () => {
	await withRegistry(async ({ registry, rows, setAgents }) => {
		let calls = 0;
		registry.subscribeCodingAgents(WORKSPACE, () => {
			calls += 1;
		});
		await setAgents([{ terminalId: TERMINAL, agent: "codex", state: "needs-input" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE)?.length === 1);
		await waitFor(() => calls >= 1);
		const before = calls;

		rows.length = 0; // the workspace stops running
		// The drop tells listeners at once, not after the throttle window.
		await waitFor(() => registry.codingAgents(WORKSPACE) === null);
		expect(calls).toBe(before + 1);
	});
});

test("a connection made after the states were set gets them in the first frame", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "finished" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE)?.length === 1);
		expect(registry.codingAgents(WORKSPACE)?.[0]?.state).toBe("finished");
	});
});

test("the list is null until the agent's first frame arrives", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		// Nothing has connected yet, and an empty list would be a baseline
		// the agent never sent.
		expect(registry.codingAgents(WORKSPACE)).toBeNull();
		await setAgents([]);
		await waitFor(() => registry.codingAgents(WORKSPACE) !== null);
		expect(registry.codingAgents(WORKSPACE)).toEqual([]);
	});
});

test("a burst of differing frames is throttled and ends on the newest list", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		await waitFor(() => registry.codingAgents(WORKSPACE) !== null);
		const seen: string[] = [];
		registry.subscribeCodingAgents(WORKSPACE, () => {
			seen.push(registry.codingAgents(WORKSPACE)?.[0]?.since ?? "");
		});
		// Every frame differs, as a workspace trying to flood the API would send.
		const started = Date.now();
		for (let i = 0; i < 1000; i++) {
			await setAgents([
				{
					terminalId: TERMINAL,
					agent: "claude",
					state: "working",
					since: new Date(1_000_000 + i).toISOString(),
				},
			]);
		}
		const elapsed = Date.now() - started;
		const newest = new Date(1_000_000 + 999).toISOString();
		await waitFor(() => seen.at(-1) === newest);
		// At most four a second, plus the one that ends the burst.
		expect(seen.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 1);
		expect(seen.length).toBeLessThan(50);
	});
});

test("only listeners of the workspace that changed are called", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		let otherCalls = 0;
		let ownCalls = 0;
		registry.subscribeCodingAgents("44444444-4444-4444-8444-444444444444", () => {
			otherCalls += 1;
		});
		registry.subscribeCodingAgents(WORKSPACE, () => {
			ownCalls += 1;
		});
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "working" }]);
		await waitFor(() => ownCalls >= 1);
		expect(otherCalls).toBe(0);
	});
});

test("a subagent that finishes inside a throttle window is not lost", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		await waitFor(() => registry.codingAgents(WORKSPACE) !== null);
		const seen: string[] = [];
		registry.subscribeCodingAgents(WORKSPACE, () => {
			seen.push(registry.codingAgents(WORKSPACE)?.[0]?.subagents[0]?.state ?? "");
		});
		const status = (state: "working" | "finished") => [
			{
				terminalId: TERMINAL,
				agent: "claude",
				state: "working",
				since: "2027-01-15T07:00:00.000Z",
				subagents: [
					{
						id: "toolu_01ABC",
						type: "Explore",
						description: "Find the parser",
						state,
						since: "2027-01-15T07:00:00.000Z",
					},
				],
			},
		];
		// Back to back, so both land in one window.
		await setAgents(status("working"));
		await setAgents(status("finished"));
		await waitFor(() => seen.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(seen.at(-1)).toBe("finished");
	});
});
