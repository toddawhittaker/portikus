import {
	AgentCreateProjectRequest,
	AgentCreateTerminalRequest,
	AgentCreateTerminalResponse,
	AgentDuplicateProjectRequest,
	AgentError as AgentErrorBody,
	type AgentErrorCode,
	AgentProject,
	AgentProjectList,
	AgentRenameProjectRequest,
	type LogLevel,
	LoopbackForward,
	LoopbackForwardRequest,
	SetLogLevelRequest,
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
export const AGENT_TIMEOUT_MS = 5000;

/**
 * Stopping waits three seconds for SIGTERM before SIGKILL, so the agent needs
 * longer than the usual call (SPEC.md 18.2).
 */
export const STOP_TIMEOUT_MS = 20_000;

/** Creating a project may clone a repository, which is slow. */
const AGENT_CREATE_PROJECT_TIMEOUT_MS = 5 * 60 * 1000;

/** Copying a whole project tree is as slow as a clone, so it gets the same budget. */
const AGENT_DUPLICATE_PROJECT_TIMEOUT_MS = AGENT_CREATE_PROJECT_TIMEOUT_MS;

/** Most bytes the API will buffer from an agent JSON body. */
const AGENT_JSON_LIMIT_BYTES = 1024 * 1024;

/** How long the agent has to send response headers for a download. */
const AGENT_DOWNLOAD_HEADERS_TIMEOUT_MS = 5000;

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

	/** The websocket URL the project's filesystem events are piped from. */
	projectEventsUrl(slug: string): string {
		return `ws://${this.address}:${this.port}/projects/${encodeURIComponent(slug)}/events`;
	}

	/** The websocket URL the workspace's listening-port changes arrive on. */
	listeningEventsUrl(): string {
		return `ws://${this.address}:${this.port}/listening/events`;
	}

	/** Ask the agent to open a loopback forward (BROWSER-HANDLING.md §11.1). */
	async openForward(port: number): Promise<LoopbackForward> {
		const payload = await this.call(
			"POST",
			"/forwards",
			LoopbackForwardRequest.parse({ port }),
		);
		return LoopbackForward.parse(payload);
	}

	/** Stop what holds a port inside the workspace (SPEC.md 18.2). */
	async stopListener(port: number): Promise<void> {
		await this.call("POST", `/listening/${port}/stop`, undefined, STOP_TIMEOUT_MS);
	}

	/**
	 * Close a loopback forward. Best effort: a forward that is already gone,
	 * or an agent that has stopped, leaves nothing for us to clean up.
	 */
	async closeForward(port: number): Promise<void> {
		await this.call("DELETE", `/forwards/${port}`).catch(() => undefined);
	}

	/** The websocket URL one check run's output is piped from (SPEC.md §18.1). */
	checkOutputUrl(slug: string, checkId: string): string {
		return `ws://${this.address}:${this.port}/projects/${encodeURIComponent(slug)}/checks/${encodeURIComponent(checkId)}/runs/current`;
	}

	/** The Authorization header for the agent. Never log the result. */
	authHeader(): string {
		return `Bearer ${this.token}`;
	}

	async createTerminal(
		input: AgentCreateTerminalRequest,
	): Promise<AgentCreateTerminalResponse> {
		const payload = await this.call(
			"POST",
			"/terminals",
			AgentCreateTerminalRequest.parse(input),
		);
		// An agent that has not started recording baselines still answers with
		// its older terminal body. Missing ids are null; a wrong type is not.
		const record =
			payload !== null && typeof payload === "object"
				? (payload as Record<string, unknown>)
				: {};
		const parsed = AgentCreateTerminalResponse.safeParse({
			baselineObjectId: record.baselineObjectId ?? null,
			baselineHead: record.baselineHead ?? null,
		});
		if (!parsed.success) {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent sent an answer we could not read.",
			);
		}
		return parsed.data;
	}

	async deleteTerminal(terminalId: string): Promise<void> {
		await this.call("DELETE", `/terminals/${terminalId}`);
	}

	/** Set how much this workspace's agent logs, while it runs (ADR 0012). */
	async setLogLevel(level: LogLevel | null): Promise<void> {
		await this.call("PUT", "/log-level", SetLogLevelRequest.parse({ level }));
	}

	async listProjects(): Promise<AgentProjectList> {
		return AgentProjectList.parse(await this.call("GET", "/projects"));
	}

	async createProject(input: {
		slug: string;
		source: "new" | "clone" | "template";
		url?: string;
		gitInit: boolean;
	}): Promise<AgentProject> {
		const payload = await this.call(
			"POST",
			"/projects",
			AgentCreateProjectRequest.parse(input),
			AGENT_CREATE_PROJECT_TIMEOUT_MS,
		);
		return AgentProject.parse(payload);
	}

	async renameProject(slug: string, to: string): Promise<void> {
		await this.call(
			"POST",
			`/projects/${slug}/rename`,
			AgentRenameProjectRequest.parse({ to }),
		);
	}

	async duplicateProject(slug: string, to: string): Promise<void> {
		await this.call(
			"POST",
			`/projects/${slug}/duplicate`,
			AgentDuplicateProjectRequest.parse({ to }),
			AGENT_DUPLICATE_PROJECT_TIMEOUT_MS,
		);
	}

	async deleteProject(slug: string): Promise<void> {
		await this.call("DELETE", `/projects/${slug}`);
	}

	async gitInit(slug: string): Promise<void> {
		await this.call("POST", `/projects/${slug}/git-init`);
	}

	/**
	 * The upstream zip response, still streaming. The agent gets a short budget
	 * to send headers; once bytes are flowing there is no further cap, because
	 * archiving a large project legitimately takes a while.
	 */
	async downloadProject(slug: string, relPath = ""): Promise<Response> {
		const controller = new AbortController();
		const headersTimer = setTimeout(
			() => controller.abort(),
			AGENT_DOWNLOAD_HEADERS_TIMEOUT_MS,
		);
		let response: Response;
		try {
			response = await fetch(
				`http://${this.address}:${this.port}/projects/${slug}/archive` +
					(relPath === "" ? "" : `?path=${encodeURIComponent(relPath)}`),
				{
					method: "GET",
					headers: { authorization: this.authHeader() },
					signal: controller.signal,
				},
			);
		} catch {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent could not be reached",
			);
		} finally {
			clearTimeout(headersTimer);
		}
		if (!response.ok) {
			const parsed = AgentErrorBody.safeParse(await readJson(response));
			throw new AgentCallError(
				parsed.success ? parsed.data.error.code : "AGENT_UNAVAILABLE",
				parsed.success ? parsed.data.error.message : "The workspace agent failed",
			);
		}
		return response;
	}

	/**
	 * A raw call to the agent, with both bodies left as streams. File reads,
	 * writes and archives can be far larger than the JSON cap, so nothing here
	 * is buffered; the caller decides what to do with the response
	 * (SPEC.md §5.2, §11.2).
	 */
	async fetchRaw(
		method: string,
		path: string,
		options: {
			headers?: Record<string, string>;
			body?: Buffer | ReadableStream<Uint8Array>;
			signal?: AbortSignal;
		} = {},
	): Promise<Response> {
		try {
			return await fetch(`http://${this.address}:${this.port}${path}`, {
				method,
				// The token goes on last: a caller cannot override it.
				headers: { ...options.headers, authorization: this.authHeader() },
				body: options.body,
				...(options.signal ? { signal: options.signal } : {}),
				// Required by undici whenever the request body is a stream.
				duplex: "half",
			} as RequestInit);
		} catch {
			throw new AgentCallError(
				"AGENT_UNAVAILABLE",
				"The workspace agent could not be reached",
			);
		}
	}

	private async call(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs: number = AGENT_TIMEOUT_MS,
	): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`http://${this.address}:${this.port}${path}`, {
				method,
				headers: {
					authorization: this.authHeader(),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Read a JSON body with a hard byte cap. The agent runs inside the student's
 * container, so its response is untrusted and must never be buffered without
 * a limit (SPEC.md §24.6).
 */
export async function readJson(response: Response): Promise<unknown> {
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
			if (total > AGENT_JSON_LIMIT_BYTES) {
				reader.cancel().catch(() => {});
				throw new AgentCallError("AGENT_UNAVAILABLE", "agent response too large");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof AgentCallError) throw error;
		return undefined;
	}
	if (total === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * The failure an unsuccessful agent response stands for, read from its error
 * body. The body is small, so it goes through the same capped reader.
 */
export async function readAgentError(response: Response): Promise<AgentCallError> {
	const parsed = AgentErrorBody.safeParse(await readJson(response));
	return new AgentCallError(
		parsed.success ? parsed.data.error.code : "AGENT_UNAVAILABLE",
		parsed.success ? parsed.data.error.message : "The workspace agent failed",
	);
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
