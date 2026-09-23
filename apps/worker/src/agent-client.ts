import {
	AgentCreateRecoveryPointRequest,
	AgentCreateRecoveryPointResponse,
	AgentError as AgentErrorBody,
} from "@portikus/contracts";

/** Archiving a large project is slow, but a hung agent must not hold the sweep for long. */
export const CREATE_TIMEOUT_MS = 2 * 60 * 1000;
export const DELETE_TIMEOUT_MS = 30 * 1000;

/** Most bytes the worker will buffer from an agent JSON body. */
const AGENT_JSON_LIMIT_BYTES = 1024 * 1024;

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

	private async call(
		method: string,
		path: string,
		body: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		// One signal bounds both the request and reading the body.
		const signal = AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetch(`http://${this.address}:${this.port}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal,
				redirect: "manual",
			});
		} catch {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent is unreachable",
			);
		}
		// The agent runs in the student's container: never follow its redirects.
		if (res.status >= 300 && res.status < 400) {
			res.body?.cancel().catch(() => {});
			throw new AgentCallError("AGENT_UNAVAILABLE", `Agent returned ${res.status}`);
		}
		const json = await readJson(res);
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

/** The agent factory for agents listening on `port` (the AGENT_PORT setting). */
export function httpAgentFactory(port: number): AgentFactory {
	return (address, token) => new HttpRecoveryAgent(address, port, token);
}

/**
 * Read a JSON body with a hard byte cap. The agent runs inside the student's
 * container, so its reply is untrusted and must never be buffered without a
 * limit (SPEC.md §24.6). A body that is not JSON reads as undefined.
 */
async function readJson(res: Response): Promise<unknown> {
	const body = res.body;
	if (!body) return undefined;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > AGENT_JSON_LIMIT_BYTES) {
				reader.cancel().catch(() => {});
				throw new AgentCallError("AGENT_UNAVAILABLE", "Agent response too large");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof AgentCallError) throw error;
		throw new AgentCallError("AGENT_UNAVAILABLE", "The workspace agent is unreachable");
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}
