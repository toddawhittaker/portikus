import {
	AgentCreateRecoveryPointRequest,
	AgentCreateRecoveryPointResponse,
	AgentError as AgentErrorBody,
} from "@portikus/contracts";

/**
 * The port every workspace agent listens on. The worker config has no
 * AGENT_PORT, and the agent's own default is this value.
 */
export const AGENT_PORT = 7400;

/** Archiving a large project is slow, but a hung agent must not hold the sweep forever. */
const CREATE_TIMEOUT_MS = 10 * 60 * 1000;
const DELETE_TIMEOUT_MS = 30 * 1000;

/** A failed call to the workspace agent; `code` is the agent's code or AGENT_UNAVAILABLE. */
export class AgentCallError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "AgentCallError";
		this.code = code;
	}
}

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
		private readonly token: string,
	) {}

	async createRecoveryPoint(
		slug: string,
		req: AgentCreateRecoveryPointRequest,
	): Promise<AgentCreateRecoveryPointResponse> {
		const body = await this.call(
			"POST",
			`/projects/${encodeURIComponent(slug)}/recovery-points`,
			AgentCreateRecoveryPointRequest.parse(req),
			CREATE_TIMEOUT_MS,
		);
		return AgentCreateRecoveryPointResponse.parse(body);
	}

	async deleteRecoveryPoint(projectId: string, pointId: string): Promise<void> {
		await this.call(
			"DELETE",
			`/recovery-points/${encodeURIComponent(projectId)}/${encodeURIComponent(pointId)}`,
			undefined,
			DELETE_TIMEOUT_MS,
		);
	}

	private async call(
		method: string,
		path: string,
		body: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(`http://${this.address}:${AGENT_PORT}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent is unreachable",
			);
		}
		const json = await res.json().catch(() => null);
		if (!res.ok) {
			const parsed = AgentErrorBody.safeParse(json);
			if (parsed.success) {
				throw new AgentCallError(parsed.data.error.code, parsed.data.error.message);
			}
			throw new AgentCallError("AGENT_UNAVAILABLE", `Agent returned ${res.status}`);
		}
		return json;
	}
}

export const httpAgentFactory: AgentFactory = (address, token) =>
	new HttpRecoveryAgent(address, token);
