import {
	AgentCreateTerminalRequest,
	AgentError as AgentErrorBody,
	type AgentErrorCode,
} from "@portikus/contracts";

/** Error codes the API uses for agent trouble: the agent's own, or "unreachable". */
export type AgentFailureCode = AgentErrorCode | "AGENT_UNAVAILABLE";

/** A failed call to the workspace agent (ADR 0009; SPEC.md §9.7). */
export class AgentCallError extends Error {
	readonly code: AgentFailureCode;

	constructor(code: AgentFailureCode, message: string) {
		super(message);
		this.name = "AgentCallError";
		this.code = code;
	}
}

/** How long any one agent call may take before it is treated as unreachable. */
const AGENT_TIMEOUT_MS = 5000;

/**
 * The control plane's side of the workspace agent API (ADR 0009, SPEC.md §9.7).
 * The bearer token is per workspace and must never be logged (SPEC.md §24.8).
 */
export class AgentClient {
	private readonly address: string;
	private readonly port: number;
	private readonly token: string;

	constructor(address: string, port: number, token: string) {
		this.address = address;
		this.port = port;
		this.token = token;
	}

	/** The websocket URL a browser attachment is piped to. */
	attachUrl(terminalId: string, cols: number, rows: number): string {
		const query = new URLSearchParams({ cols: String(cols), rows: String(rows) });
		return `ws://${this.address}:${this.port}/terminals/${terminalId}/attach?${query}`;
	}

	/** The Authorization header for the agent. Never log the result. */
	authHeader(): string {
		return `Bearer ${this.token}`;
	}

	async createTerminal(input: { id: string; cwd: string }): Promise<void> {
		await this.call("POST", "/terminals", AgentCreateTerminalRequest.parse(input));
	}

	async deleteTerminal(terminalId: string): Promise<void> {
		await this.call("DELETE", `/terminals/${terminalId}`);
	}

	private async call(method: string, path: string, body?: unknown): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`http://${this.address}:${this.port}${path}`, {
				method,
				headers: {
					authorization: this.authHeader(),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
			});
		} catch {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent could not be reached",
			);
		}

		const payload = await readJson(response);
		if (!response.ok) {
			const parsed = AgentErrorBody.safeParse(payload);
			throw new AgentCallError(
				parsed.success ? parsed.data.error.code : "AGENT_UNAVAILABLE",
				parsed.success ? parsed.data.error.message : "The workspace agent failed",
			);
		}
		return payload;
	}
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Build a client for a workspace row, or null when it has no agent yet. */
export function agentClientFor(
	row: Record<string, unknown>,
	agentPort: number,
): AgentClient | null {
	const address = row.agent_address;
	const token = row.agent_token;
	if (typeof address !== "string" || typeof token !== "string") return null;
	if (address === "" || token === "") return null;
	return new AgentClient(address, agentPort, token);
}
