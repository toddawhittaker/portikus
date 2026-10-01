import { AgentCallError, callAgent, readJson } from "@portikus/agent-client";
import {
	AgentCreateRecoveryPointRequest,
	AgentCreateRecoveryPointResponse,
	AgentDockerInventory,
} from "@portikus/contracts";

export { AgentCallError };

/** Archiving a large project is slow, but a hung agent must not hold the sweep for long. */
export const CREATE_TIMEOUT_MS = 2 * 60 * 1000;
export const DELETE_TIMEOUT_MS = 30 * 1000;

/** The recovery operations the worker needs from a workspace agent (ADR 0020). */
export interface RecoveryAgent {
	createRecoveryPoint(
		slug: string,
		req: AgentCreateRecoveryPointRequest,
	): Promise<AgentCreateRecoveryPointResponse>;
	deleteRecoveryPoint(projectId: string, pointId: string): Promise<void>;
}

/** Builds the agent client for one workspace from its address and token. */
export type AgentFactory = (address: string, token: string) => RecoveryAgent;

/** HTTP client for the agent's recovery routes. The token must never be logged. */
export class HttpRecoveryAgent implements RecoveryAgent {
	constructor(
		private readonly address: string,
		private readonly port: number,
		private readonly token: string,
		private readonly timeouts = {
			create: CREATE_TIMEOUT_MS,
			delete: DELETE_TIMEOUT_MS,
		},
	) {}

	async createRecoveryPoint(
		slug: string,
		req: AgentCreateRecoveryPointRequest,
	): Promise<AgentCreateRecoveryPointResponse> {
		const body = await this.call(
			"POST",
			`/projects/${encodeURIComponent(slug)}/recovery-points`,
			AgentCreateRecoveryPointRequest.parse(req),
			this.timeouts.create,
		);
		return AgentCreateRecoveryPointResponse.parse(body);
	}

	async deleteRecoveryPoint(projectId: string, pointId: string): Promise<void> {
		await this.call(
			"DELETE",
			`/recovery-points/${encodeURIComponent(projectId)}/${encodeURIComponent(pointId)}`,
			undefined,
			this.timeouts.delete,
		);
	}

	private call(
		method: string,
		path: string,
		body: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		return callAgent(
			{ address: this.address, port: this.port, token: this.token },
			method,
			path,
			body,
			timeoutMs,
		);
	}
}

/** The agent's own docker calls take up to 10 s each; three run in turn. */
export const INVENTORY_TIMEOUT_MS = 45 * 1000;
/** The agent caps docker's output at 4 MiB; its JSON reply stays below twice that. */
const INVENTORY_JSON_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * `GET /docker/inventory` on one agent. Any failure, including
 * a reply that fails the schema, is null: no data.
 */
export async function fetchDockerInventory(
	address: string,
	port: number,
	token: string,
	timeoutMs = INVENTORY_TIMEOUT_MS,
): Promise<AgentDockerInventory | null> {
	try {
		const res = await fetch(`http://${address}:${port}/docker/inventory`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		if (res.status !== 200) {
			res.body?.cancel().catch(() => {});
			return null;
		}
		const parsed = AgentDockerInventory.safeParse(
			await readJson(res, INVENTORY_JSON_LIMIT_BYTES),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The agent factory for agents listening on `port` (the AGENT_PORT setting). */
export function httpAgentFactory(port: number): AgentFactory {
	return (address, token) => new HttpRecoveryAgent(address, port, token);
}
