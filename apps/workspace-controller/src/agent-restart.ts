import { errorMessage, type Logger } from "@portikus/observability";

/**
 * The installed agent's entry point on the host. dpkg writes every file of
 * the package on each upgrade, so its change time (which nothing can set
 * back) is when the installed agent last changed.
 */
export const AGENT_ENTRY_PATH = "/usr/lib/portikus/workspace-agent/dist/index.js";

/** A running workspace's agent as the host sees it. */
export interface RunningAgent {
	name: string;
	/** The instance's `image.serial`, set by the host from the image. */
	imageSerial: string | null;
	/** When the agent's main process started, or null when it is not running. */
	startedAt: Date | null;
}

export interface AgentRestarter {
	runningAgents(): Promise<RunningAgent[]>;
	restartAgent(name: string): Promise<void>;
}

/** True when the image serial (YYYY.MM.N) is 2026.09.11 or later. */
export function imageKeepsTerminals(serial: string | null): boolean {
	const match = /^(\d{4})\.(\d{1,2})\.(\d+)$/.exec(serial ?? "");
	if (!match) return false;
	return match[0].localeCompare("2026.09.11", undefined, { numeric: true }) >= 0;
}

/**
 * Restart the agent in each running workspace whose agent started before
 * the installed agent files changed. One workspace at a time; a
 * failure is logged and the next one goes ahead.
 */
export async function restartOutdatedAgents(opts: {
	restarter: AgentRestarter;
	agentChangedAt: Date;
	logger: Logger;
}): Promise<void> {
	const { restarter, agentChangedAt, logger } = opts;
	const agents = await restarter.runningAgents();
	for (const agent of agents) {
		if (!agent.startedAt || agent.startedAt >= agentChangedAt) continue;
		if (!imageKeepsTerminals(agent.imageSerial)) {
			logger.warn(
				{ instance: agent.name, image: agent.imageSerial },
				"workspace runs the old workspace agent until it is stopped and started; " +
					"its image is older than 2026.09.11, where an agent restart would end its terminals",
			);
			continue;
		}
		try {
			await restarter.restartAgent(agent.name);
			logger.info(
				{ instance: agent.name },
				"restarted the workspace agent after an upgrade",
			);
		} catch (err) {
			// The workspace may have stopped meanwhile; its next start runs the new agent.
			logger.warn(
				{ instance: agent.name, err: errorMessage(err) },
				"could not restart the workspace agent after an upgrade",
			);
		}
	}
}
