import { AgentError as AgentErrorBody } from "@portikus/contracts";

/**
 * The shared HTTP transport to the workspace agent (ADR 0009, SPEC.md §9.7).
 * The agent runs inside the student's container, so every reply is untrusted:
 * bodies are read under a byte cap and redirects are never followed
 * (SPEC.md §24.6). The bearer token must never be logged (SPEC.md §24.8).
 */

/** Most bytes a caller will buffer from an agent JSON body. */
export const AGENT_JSON_LIMIT_BYTES = 1024 * 1024;

/** A failed call to the workspace agent; `code` is the agent's code or AGENT_UNAVAILABLE. */
export class AgentCallError extends Error {
	readonly code: string;
	/** The agent's HTTP status, when it answered with one. */
	readonly status: number | undefined;

	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = "AgentCallError";
		this.code = code;
		this.status = status;
	}
}

/** The agent's reply body broke off mid-stream, as a dropped connection does. */
export class AgentStreamError extends AgentCallError {
	constructor() {
		super("AGENT_UNAVAILABLE", "The workspace agent could not be reached");
		this.name = "AgentStreamError";
	}
}

/** Where one agent listens and the per-workspace token it expects. */
export interface AgentTarget {
	address: string;
	port: number;
	token: string;
}

/**
 * Send one JSON request to the agent and return its parsed JSON reply, or
 * undefined for an empty or non-JSON reply. One signal bounds both the request
 * and reading the body. An error reply becomes an AgentCallError with the
 * agent's own code when its body says one.
 */
export async function callAgent(
	target: AgentTarget,
	method: string,
	path: string,
	body: unknown,
	timeoutMs: number,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`http://${target.address}:${target.port}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${target.token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
	} catch {
		throw unreachable();
	}

	throwOnRedirect(response);
	const payload = await readJson(response);
	if (!response.ok) {
		const parsed = AgentErrorBody.safeParse(payload);
		throw new AgentCallError(
			parsed.success ? parsed.data.error.code : "AGENT_UNAVAILABLE",
			parsed.success ? parsed.data.error.message : "The workspace agent failed",
			response.status,
		);
	}
	return payload;
}

/**
 * Every agent fetch uses `redirect: "manual"`: a replaced agent must not
 * steer the platform to loopback or the workspace network, so a redirect is
 * a failed agent.
 */
export function throwOnRedirect(response: Response): void {
	if (response.status >= 300 && response.status < 400) {
		response.body?.cancel().catch(() => {});
		throw new AgentCallError("AGENT_UNAVAILABLE", "The workspace agent redirected");
	}
}

/**
 * Read a JSON body with a hard byte cap. A body past the cap, or one that
 * breaks mid-stream, throws. An empty body or one that is not JSON reads as
 * undefined.
 */
export async function readJson(
	response: Response,
	limitBytes = AGENT_JSON_LIMIT_BYTES,
): Promise<unknown> {
	const body = response.body;
	if (!body) return undefined;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limitBytes) {
				reader.cancel().catch(() => {});
				throw new AgentCallError("AGENT_UNAVAILABLE", "agent response too large");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof AgentCallError) throw error;
		throw new AgentStreamError();
	}
	if (total === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

function unreachable(): AgentCallError {
	return new AgentCallError(
		"AGENT_UNAVAILABLE",
		"The workspace agent could not be reached",
	);
}
