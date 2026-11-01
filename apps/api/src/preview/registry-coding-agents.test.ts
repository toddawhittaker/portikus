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
		const seen: Array<[string, number]> = [];
		const unsubscribe = registry.subscribeCodingAgents((workspaceId, terminals) => {
			seen.push([workspaceId, terminals.length]);
		});
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "working" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE).length === 1);
		expect(registry.codingAgents(WORKSPACE)[0]).toMatchObject({
			terminalId: TERMINAL,
			agent: "claude",
			state: "working",
		});
		expect(seen).toContainEqual([WORKSPACE, 1]);

		unsubscribe();
		const before = seen.length;
		await setAgents([]);
		await waitFor(() => registry.codingAgents(WORKSPACE).length === 0);
		expect(seen).toHaveLength(before);
	});
});

test("an invalid coding-agent frame is ignored and only field names are logged", async () => {
	await withRegistry(async ({ registry, lines, setAgents }) => {
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "working" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE).length === 1);

		await setAgents([
			{ terminalId: TERMINAL, agent: "claude", state: "SECRET-prompt-text" },
		]);
		await waitFor(() =>
			lines.some((line) => line.msg === "coding agents frame rejected"),
		);
		expect(registry.codingAgents(WORKSPACE)[0]?.state).toBe("working");
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
		const seen: Array<[string, number]> = [];
		registry.subscribeCodingAgents((workspaceId, terminals) => {
			seen.push([workspaceId, terminals.length]);
		});
		await setAgents([{ terminalId: TERMINAL, agent: "codex", state: "needs-input" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE).length === 1);

		rows.length = 0; // the workspace stops running
		await waitFor(() => seen.at(-1)?.[1] === 0);
		expect(seen.at(-1)).toEqual([WORKSPACE, 0]);
		expect(registry.codingAgents(WORKSPACE)).toEqual([]);
	});
});

test("a connection made after the states were set gets them in the first frame", async () => {
	await withRegistry(async ({ registry, setAgents }) => {
		await setAgents([{ terminalId: TERMINAL, agent: "claude", state: "finished" }]);
		await waitFor(() => registry.codingAgents(WORKSPACE).length === 1);
		expect(registry.codingAgents(WORKSPACE)[0]?.state).toBe("finished");
	});
});
