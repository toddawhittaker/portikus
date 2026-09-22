import type {
	ControllerErrorCode,
	CreateInstanceRequest,
	CreateInstanceResponse,
	ListInstancesResponse,
	LogLevel,
	RebuildInstanceRequest,
	RebuildInstanceResponse,
	ResetDockerRequest,
	StartInstanceRequest,
	StartInstanceResponse,
	StopInstanceResponse,
} from "@portikus/contracts";
import {
	ControllerError,
	CreateInstanceResponse as CreateInstanceResponseSchema,
	ListInstancesResponse as ListInstancesResponseSchema,
	RebuildInstanceResponse as RebuildInstanceResponseSchema,
	StartInstanceResponse as StartInstanceResponseSchema,
	StopInstanceResponse as StopInstanceResponseSchema,
} from "@portikus/contracts";

/** Error thrown by the controller client, carrying the error code. */
export class ControllerClientError extends Error {
	readonly code: ControllerErrorCode;
	constructor(code: ControllerErrorCode, message: string) {
		super(message);
		this.name = "ControllerClientError";
		this.code = code;
	}
}

/** Operations the worker needs from the workspace controller. */
export interface ControllerClient {
	create(req: CreateInstanceRequest): Promise<CreateInstanceResponse>;
	start(name: string, req: StartInstanceRequest): Promise<StartInstanceResponse>;
	stop(name: string, timeoutSeconds: number): Promise<StopInstanceResponse>;
	list(): Promise<ListInstancesResponse>;
	/** Relay the runtime log level to the controller (ADR 0012). */
	setLogLevel(level: LogLevel | null): Promise<void>;
	/** Replace the Docker volume of a stopped instance (SPEC.md §16.4, ADR 0021). */
	resetDocker(name: string, req: ResetDockerRequest): Promise<void>;
	/** Replace the root filesystem of a stopped instance (SPEC.md §17.2, ADR 0021). */
	rebuild(name: string, req: RebuildInstanceRequest): Promise<RebuildInstanceResponse>;
}

/**
 * Controller client that talks to the real HTTP controller
 * (SPEC section 27; STACK section 9).
 */
export class HttpControllerClient implements ControllerClient {
	private readonly baseUrl: string;
	private readonly token: string;

	constructor(baseUrl: string, token: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
	}

	async create(req: CreateInstanceRequest): Promise<CreateInstanceResponse> {
		const res = await this.request("POST", "/instances", req);
		return CreateInstanceResponseSchema.parse(res);
	}

	async start(name: string, req: StartInstanceRequest): Promise<StartInstanceResponse> {
		const res = await this.request(
			"POST",
			`/instances/${encodeURIComponent(name)}/start`,
			req,
		);
		return StartInstanceResponseSchema.parse(res);
	}

	async stop(name: string, timeoutSeconds: number): Promise<StopInstanceResponse> {
		const res = await this.request(
			"POST",
			`/instances/${encodeURIComponent(name)}/stop`,
			{ timeoutSeconds },
		);
		return StopInstanceResponseSchema.parse(res);
	}

	async list(): Promise<ListInstancesResponse> {
		const res = await this.request("GET", "/instances");
		return ListInstancesResponseSchema.parse(res);
	}

	async setLogLevel(level: LogLevel | null): Promise<void> {
		await this.request("PUT", "/log-level", { level });
	}

	async resetDocker(name: string, req: ResetDockerRequest): Promise<void> {
		await this.request(
			"POST",
			`/instances/${encodeURIComponent(name)}/reset-docker`,
			req,
		);
	}

	async rebuild(
		name: string,
		req: RebuildInstanceRequest,
	): Promise<RebuildInstanceResponse> {
		const res = await this.request(
			"POST",
			`/instances/${encodeURIComponent(name)}/rebuild`,
			req,
		);
		return RebuildInstanceResponseSchema.parse(res);
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch {
			throw new ControllerClientError("INCUS_UNAVAILABLE", "Controller is unreachable");
		}

		const json = await res.json().catch(() => null);

		if (!res.ok) {
			const parsed = ControllerError.safeParse(json);
			if (parsed.success) {
				throw new ControllerClientError(parsed.data.code, parsed.data.message);
			}
			throw new ControllerClientError(
				"INCUS_UNAVAILABLE",
				`Controller returned ${res.status}`,
			);
		}

		return json;
	}
}
