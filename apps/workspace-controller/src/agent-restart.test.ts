/**
 * After an upgrade the controller restarts outdated workspace agents
 * (issue #887; SPEC.md 9.7, 22.5): only running workspaces whose agent
 * started before the agent files changed, never an image older than
 * 2026.09.11, each at most once, and one failure never stops the rest.
 */
import { collectingLogger } from "@portikus/observability/testing";
import { expect, test } from "vitest";
import {
	type AgentRestarter,
	imageKeepsTerminals,
	type RunningAgent,
	restartOutdatedAgents,
} from "./agent-restart.js";

const UPGRADED = new Date("2026-09-30T10:00:00Z");
const BEFORE = new Date("2026-09-29T08:00:00Z");
const AFTER = new Date("2026-09-30T10:00:05Z");

function restarter(agents: RunningAgent[], failing: string[] = []) {
	const restarted: string[] = [];
	const fake: AgentRestarter = {
		runningAgents: async () => agents,
		restartAgent: async (name) => {
			restarted.push(name);
			if (failing.includes(name)) throw new Error("instance is not running");
		},
	};
	return { fake, restarted };
}

test("the image floor is 2026.09.11, compared as numbers", () => {
	expect(imageKeepsTerminals("2026.09.11")).toBe(true);
	expect(imageKeepsTerminals("2026.09.14")).toBe(true);
	expect(imageKeepsTerminals("2026.10.1")).toBe(true);
	expect(imageKeepsTerminals("2027.01.1")).toBe(true);
	expect(imageKeepsTerminals("2026.09.9")).toBe(false);
	expect(imageKeepsTerminals("2026.09.10")).toBe(false);
	expect(imageKeepsTerminals("2025.12.40")).toBe(false);
	expect(imageKeepsTerminals(null)).toBe(false);
	expect(imageKeepsTerminals("latest")).toBe(false);
});

test("restarts only agents that started before the upgrade, on a safe image", async () => {
	const { logger, lines } = collectingLogger();
	const { fake, restarted } = restarter([
		{ name: "ws-old", imageSerial: "2026.09.14", startedAt: BEFORE },
		{ name: "ws-new", imageSerial: "2026.09.14", startedAt: AFTER },
		{ name: "ws-same", imageSerial: "2026.09.14", startedAt: UPGRADED },
		{ name: "ws-noagent", imageSerial: "2026.09.14", startedAt: null },
	]);
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	expect(restarted).toEqual(["ws-old"]);
	expect(lines.filter((l) => l.level === "warn")).toEqual([]);
});

test("skips an old or unknown image and says so at warn", async () => {
	const { logger, lines } = collectingLogger();
	const { fake, restarted } = restarter([
		{ name: "ws-2026-09-9", imageSerial: "2026.09.9", startedAt: BEFORE },
		{ name: "ws-unknown", imageSerial: null, startedAt: BEFORE },
	]);
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	expect(restarted).toEqual([]);
	const warned = lines.filter((l) => l.level === "warn").map((l) => l.instance);
	expect(warned).toEqual(["ws-2026-09-9", "ws-unknown"]);
});

test("a workspace that fails or stopped meanwhile does not stop the others", async () => {
	const { logger, lines } = collectingLogger();
	const { fake, restarted } = restarter(
		[
			{ name: "ws-a", imageSerial: "2026.09.14", startedAt: BEFORE },
			{ name: "ws-b", imageSerial: "2026.09.14", startedAt: BEFORE },
		],
		["ws-a"],
	);
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	expect(restarted).toEqual(["ws-a", "ws-b"]);
	const warn = lines.find((l) => l.level === "warn");
	expect(warn?.instance).toBe("ws-a");
	expect(warn?.err).toBe("instance is not running");
});

test("never restarts the same workspace twice in one run", async () => {
	const { logger } = collectingLogger();
	const twice = { name: "ws-a", imageSerial: "2026.09.14", startedAt: BEFORE };
	const { fake, restarted } = restarter([twice, { ...twice }]);
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	expect(restarted).toEqual(["ws-a"]);
});

test("a second run after the restart leaves the agent alone", async () => {
	const { logger } = collectingLogger();
	const agent: RunningAgent = {
		name: "ws-a",
		imageSerial: "2026.09.14",
		startedAt: BEFORE,
	};
	const restarted: string[] = [];
	const fake: AgentRestarter = {
		runningAgents: async () => [agent],
		restartAgent: async (name) => {
			restarted.push(name);
			agent.startedAt = AFTER;
		},
	};
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	await restartOutdatedAgents({ restarter: fake, agentChangedAt: UPGRADED, logger });
	expect(restarted).toEqual(["ws-a"]);
});
