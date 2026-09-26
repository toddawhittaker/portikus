import type {
	ControllerErrorCode,
	CreateInstanceRequest,
	CreateInstanceResponse,
	GrowVolumesRequest,
	InstanceProcess,
	InstanceUsage,
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
	GrowVolumesResponse,
	HostSnapshot,
	InstanceProcessesResponse,
	InstanceUsageResponse,
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
	/** One look at the host for the admin Health tab (SPEC.md §25.6). */
	hostSnapshot(signal?: AbortSignal): Promise<HostSnapshot>;
	/** Grow a workspace's home and Docker volumes; never shrinks (SPEC.md §20.1). */
	growVolumes(name: string, req: GrowVolumesRequest): Promise<GrowVolumesResponse>;
	/** CPU time and memory of every running instance (ADR 0032). */
	usage(signal?: AbortSignal): Promise<InstanceUsage[]>;
	/** Set a time-slice CPU allowance, or remove it with null (ADR 0032). */
	setCpuAllowance(name: string, allowance: string | null): Promise<void>;
	/** The heaviest processes of a running instance, short names only (ADR 0037). */
	processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]>;
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
		signal?: AbortSignal,
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
				signal,
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

	async hostSnapshot(signal?: AbortSignal): Promise<HostSnapshot> {
		return HostSnapshot.parse(await this.request("GET", "/host", undefined, signal));
	}

	async growVolumes(
		name: string,
		req: GrowVolumesRequest,
	): Promise<GrowVolumesResponse> {
		const res = await this.request(
			"POST",
			`/instances/${encodeURIComponent(name)}/volumes`,
			req,
		);
		return GrowVolumesResponse.parse(res);
	}

	async usage(signal?: AbortSignal): Promise<InstanceUsage[]> {
		const res = await this.request("GET", "/instances/usage", undefined, signal);
		return InstanceUsageResponse.parse(res).instances;
	}

	async setCpuAllowance(name: string, allowance: string | null): Promise<void> {
		await this.request("PUT", `/instances/${encodeURIComponent(name)}/cpu-allowance`, {
			allowance,
		});
	}

	async processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]> {
		const res = await this.request(
			"GET",
			`/instances/${encodeURIComponent(name)}/processes`,
			undefined,
			signal,
		);
		return InstanceProcessesResponse.parse(res).processes;
	}
}
