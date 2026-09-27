import type {
	AddedPackagesResponse,
	CreateInstanceRequest,
	CreateInstanceResponse,
	GrowVolumesRequest,
	GrowVolumesResponse,
	HostSnapshot,
	InstanceProcess,
	InstanceUsage,
	KeptVolumesResponse,
	ListInstancesResponse,
	LogLevel,
	RebuildInstanceRequest,
	RebuildInstanceResponse,
	ReplaceHomeResponse,
	ResetDockerRequest,
	SetInstanceLimitsRequest,
	StartInstanceRequest,
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
	/** When set, every stop waits for this promise before answering. */
	stopHold: Promise<void> | null = null;
	listResult: ListInstancesResponse | Error = [];

	async create(req: CreateInstanceRequest): Promise<CreateInstanceResponse> {
		this.calls.push({ method: "create", args: [req] });
		if (this.createResult instanceof Error) throw this.createResult;
		return this.createResult;
	}

	async start(name: string, req: StartInstanceRequest): Promise<StartInstanceResponse> {
		this.calls.push({ method: "start", args: [name, req] });
		if (this.startResult instanceof Error) throw this.startResult;
		return this.startResult;
	}

	async stop(name: string, timeoutSeconds: number): Promise<StopInstanceResponse> {
		this.calls.push({ method: "stop", args: [name, timeoutSeconds] });
		if (this.stopHold) await this.stopHold;
		if (this.stopResult instanceof Error) throw this.stopResult;
		return this.stopResult;
	}

	/** Set to an Error to make the next log level push fail. */
	setLogLevelResult: Error | null = null;

	async setLogLevel(level: LogLevel | null): Promise<void> {
		this.calls.push({ method: "setLogLevel", args: [level] });
		if (this.setLogLevelResult) throw this.setLogLevelResult;
	}

	async list(): Promise<ListInstancesResponse> {
		this.calls.push({ method: "list", args: [] });
		if (this.listResult instanceof Error) throw this.listResult;
		return this.listResult;
	}

	resetDockerResult: Error | null = null;
	rebuildResult: RebuildInstanceResponse | Error = { imageFingerprint: "rebuilt456" };

	async resetDocker(name: string, req: ResetDockerRequest): Promise<void> {
		this.calls.push({ method: "resetDocker", args: [name, req] });
		if (this.resetDockerResult) throw this.resetDockerResult;
	}

	async rebuild(
		name: string,
		req: RebuildInstanceRequest,
	): Promise<RebuildInstanceResponse> {
		this.calls.push({ method: "rebuild", args: [name, req] });
		if (this.rebuildResult instanceof Error) throw this.rebuildResult;
		return this.rebuildResult;
	}

	hostResult: HostSnapshot | Error = {
		observedAt: "2026-09-22T12:00:00.000Z",
		loadAverage: [0.5, 0.25, 0.1],
		cpuCount: 4,
		memory: { usedBytes: 2 * 2 ** 30, totalBytes: 8 * 2 ** 30 },
		pool: {
			name: "workspace-data",
			usedBytes: 10 * 2 ** 30,
			totalBytes: 90 * 2 ** 30,
			metadataPercent: null,
		},
		profileLimits: { cpu: "2", memory: "4GB", processes: "2000" },
		image: { fingerprint: "abc123", serial: "2026.09.9" },
		instances: [],
		rates: null,
	};

	async hostSnapshot(signal?: AbortSignal): Promise<HostSnapshot> {
		this.calls.push({ method: "hostSnapshot", args: [signal] });
		if (this.hostResult instanceof Error) throw this.hostResult;
		return this.hostResult;
	}

	/** Set to an Error to make grows fail; otherwise the request is echoed. */
	growError: Error | null = null;

	async growVolumes(
		name: string,
		req: GrowVolumesRequest,
	): Promise<GrowVolumesResponse> {
		this.calls.push({ method: "growVolumes", args: [name, req] });
		if (this.growError) throw this.growError;
		return { homeGiB: req.homeGiB, dockerGiB: req.dockerGiB };
	}

	usageResult: InstanceUsage[] | Error = [];

	async usage(signal?: AbortSignal): Promise<InstanceUsage[]> {
		this.calls.push({ method: "usage", args: [signal] });
		if (this.usageResult instanceof Error) throw this.usageResult;
		return this.usageResult;
	}

	/** Set to an Error to make allowance writes fail. */
	setCpuAllowanceError: Error | null = null;

	async setCpuAllowance(name: string, allowance: string | null): Promise<void> {
		this.calls.push({ method: "setCpuAllowance", args: [name, allowance] });
		if (this.setCpuAllowanceError) throw this.setCpuAllowanceError;
	}

	processesResult: InstanceProcess[] | Error = [];

	async processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]> {
		this.calls.push({ method: "processes", args: [name, signal] });
		if (this.processesResult instanceof Error) throw this.processesResult;
		return this.processesResult;
	}

	/** Set to an Error to make limit writes fail. */
	setLimitsError: Error | null = null;

	async setLimits(name: string, req: SetInstanceLimitsRequest): Promise<void> {
		this.calls.push({ method: "setLimits", args: [name, req] });
		if (this.setLimitsError) throw this.setLimitsError;
	}

	addedPackagesResult: AddedPackagesResponse | Error = { image: null, packages: [] };

	async addedPackages(name: string): Promise<AddedPackagesResponse> {
		this.calls.push({ method: "addedPackages", args: [name] });
		if (this.addedPackagesResult instanceof Error) throw this.addedPackagesResult;
		return this.addedPackagesResult;
	}

	keptVolumesResult: KeptVolumesResponse | Error = { snapshots: [], keptHomes: [] };

	async keptVolumes(): Promise<KeptVolumesResponse> {
		this.calls.push({ method: "keptVolumes", args: [] });
		if (this.keptVolumesResult instanceof Error) throw this.keptVolumesResult;
		return this.keptVolumesResult;
	}

	/** Set to an Error to make snapshot and kept-home deletes fail. */
	deleteError: Error | null = null;

	async deleteSnapshot(volume: string, snapshot: string): Promise<void> {
		this.calls.push({ method: "deleteSnapshot", args: [volume, snapshot] });
		if (this.deleteError) throw this.deleteError;
	}

	async deleteKeptHome(volume: string): Promise<void> {
		this.calls.push({ method: "deleteKeptHome", args: [volume] });
		if (this.deleteError) throw this.deleteError;
	}

	replaceHomeResult: ReplaceHomeResponse | Error = {
		kept: "ws-0123456789abcdef01234567-home-replaced-1790000000",
	};

	async replaceHome(name: string): Promise<ReplaceHomeResponse> {
		this.calls.push({ method: "replaceHome", args: [name] });
		if (this.replaceHomeResult instanceof Error) throw this.replaceHomeResult;
		return this.replaceHomeResult;
	}

	/** Helper to make a ControllerClientError. */
	static error(
		code: ConstructorParameters<typeof ControllerClientError>[0],
		message = "fake error",
	): ControllerClientError {
		return new ControllerClientError(code, message);
	}
}
