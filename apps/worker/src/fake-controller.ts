import type {
	CreateInstanceRequest,
	CreateInstanceResponse,
	ListInstancesResponse,
	StartInstanceResponse,
	StopInstanceResponse,
} from "@portikus/contracts";
import type { ControllerClient } from "./controller-client.js";
import { ControllerClientError } from "./controller-client.js";

interface Call {
	method: string;
	args: unknown[];
}

/**
 * In-memory fake for tests. Records calls and returns settable results.
 */
export class FakeControllerClient implements ControllerClient {
	calls: Call[] = [];

	createResult: CreateInstanceResponse | Error = {
		created: true,
		imageFingerprint: "abc123",
		quota: { homeGiB: 25, dockerGiB: 20 },
	};

	startResult: StartInstanceResponse | Error = { ipv4: "10.0.0.2" };
	stopResult: StopInstanceResponse | Error = { forced: false };
	listResult: ListInstancesResponse | Error = [];

	async create(req: CreateInstanceRequest): Promise<CreateInstanceResponse> {
		this.calls.push({ method: "create", args: [req] });
		if (this.createResult instanceof Error) throw this.createResult;
		return this.createResult;
	}

	async start(name: string, timeoutSeconds: number): Promise<StartInstanceResponse> {
		this.calls.push({ method: "start", args: [name, timeoutSeconds] });
		if (this.startResult instanceof Error) throw this.startResult;
		return this.startResult;
	}

	async stop(name: string, timeoutSeconds: number): Promise<StopInstanceResponse> {
		this.calls.push({ method: "stop", args: [name, timeoutSeconds] });
		if (this.stopResult instanceof Error) throw this.stopResult;
		return this.stopResult;
	}

	async list(): Promise<ListInstancesResponse> {
		this.calls.push({ method: "list", args: [] });
		if (this.listResult instanceof Error) throw this.listResult;
		return this.listResult;
	}

	/** Helper to make a ControllerClientError. */
	static error(
		code: ConstructorParameters<typeof ControllerClientError>[0],
		message = "fake error",
	): ControllerClientError {
		return new ControllerClientError(code, message);
	}
}
