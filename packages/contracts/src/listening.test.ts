/**
 * The listening-service contract (SPEC.md §18.2). The command line is
 * optional: older agents, and a process whose `/proc/<pid>/cmdline` cannot
 * be read, simply leave it out.
 */
import { expect, test } from "vitest";
import { AgentListeningService, ListeningService } from "./listening.js";

const service = {
	workspaceId: "11111111-1111-4111-8111-111111111111",
	port: 3000,
	addresses: ["127.0.0.1"],
	protocolHint: "http" as const,
	process: {
		pid: 7,
		command: "MainThread",
		commandLine: "python server.py",
	},
	previewReachability: "reachable" as const,
	observedAt: "2026-01-01T00:00:00.000Z",
};

test("a listening process may carry its command line", () => {
	const parsed = ListeningService.parse(service);
	expect(parsed.process).toEqual({
		pid: 7,
		command: "MainThread",
		commandLine: "python server.py",
	});
});

test("the command line may be absent", () => {
	const parsed = ListeningService.parse({
		...service,
		process: { pid: 7, command: "node" },
	});
	expect(parsed.process).toEqual({ pid: 7, command: "node" });
});

test("the agent shape keeps the command line and has no workspace id", () => {
	const { workspaceId: _workspaceId, ...agent } = service;
	const parsed = AgentListeningService.parse(agent);
	expect(parsed.process?.commandLine).toBe("python server.py");
	expect("workspaceId" in parsed).toBe(false);
});

test("a command line that is not text is refused", () => {
	expect(
		ListeningService.safeParse({
			...service,
			process: { pid: 7, commandLine: 5 },
		}).success,
	).toBe(false);
});
