import {
	type AddedPackagesResponse,
	type ControllerErrorCode,
	type CreateInstanceResponse,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
	InstanceName,
	type InstanceProcess,
	type InstanceStatus,
	type InstanceUsage,
	KeptHomeVolumeName,
	type KeptVolumesResponse,
	PreChangeSnapshotName,
	type RebuildInstanceResponse,
	type ReplaceHomeResponse,
	type SetInstanceLimitsRequest,
	type StartInstanceResponse,
	type StopInstanceResponse,
	WorkspaceVolumeName,
} from "@portikus/contracts";
import { IncusError } from "./incus.js";
import {
	ADDED_PACKAGES_MAX_BYTES,
	InstanceNotStoppedError,
	parseAddedPackages,
	VolumeInUseError,
	type WorkspaceProvider,
} from "./provider.js";

interface FakeVolume {
	createdAt: string;
	/** Snapshot name to creation time. */
	snapshots: Map<string, string>;
}

interface FakeInstance {
	name: string;
	status: "Running" | "Stopped";
	ipv4: string | null;
	agentToken: string | null;
	hostname: string | null;
	previewHostSuffix: string | null;
	timezone: string | null;
	imageFingerprint: string;
	quota: { homeGiB: number; dockerGiB: number };
	recoveryGiB: number | null;
	/** Counts replacements, so a test can tell the Docker volume is new. */
	dockerGeneration: number;
	rebuilds: number;
	cpuAllowance: string | null;
	limits: SetInstanceLimitsRequest;
	/** The volume attached as home. */
	homeVolume: string;
	/** The apt hook's list in this fake, or null when it is missing. */
	addedPackagesFile: { type: "file" | "symlink" | "directory"; content: string } | null;
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
	readonly instances = new Map<string, FakeInstance>();
	readonly volumes = new Map<string, FakeVolume>();
	readonly hostCpuCount = 4;
	private nextError: ControllerErrorCode | null = null;
	private stopShouldHang = false;

	failNext(code: ControllerErrorCode): void {
		this.nextError = code;
	}

	setStopHangs(hangs: boolean): void {
		this.stopShouldHang = hangs;
	}

	private checkError(): void {
		if (this.nextError) {
			const code = this.nextError;
			this.nextError = null;
			throw new IncusError(code, `fake error: ${code}`);
		}
	}

	private validate(name: string): void {
		const result = InstanceName.safeParse(name);
		if (!result.success) {
			throw new IncusError("INVALID_NAME", `invalid instance name: ${name}`);
		}
	}

	async create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
	): Promise<CreateInstanceResponse> {
		this.validate(name);
		this.checkError();
		const existing = this.instances.get(name);
		if (existing) {
			return {
				created: false,
				imageFingerprint: existing.imageFingerprint,
				quota: existing.quota,
			};
		}
		const quota = { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };
		const inst: FakeInstance = {
			name,
			status: "Stopped",
			ipv4: null,
			agentToken: null,
			hostname: null,
			previewHostSuffix: null,
			timezone: null,
			imageFingerprint: "abc123",
			quota,
			recoveryGiB: sizes.recoveryGiB,
			dockerGeneration: 1,
			rebuilds: 0,
			cpuAllowance: null,
			limits: { cpu: null, memoryMiB: null, processes: null },
			homeVolume: `${name}-home`,
			addedPackagesFile: null,
		};
		this.instances.set(name, inst);
		for (const kind of ["home", "docker", "recovery"]) {
			this.addVolume(`${name}-${kind}`);
		}
		return { created: true, imageFingerprint: "abc123", quota };
	}

	async start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
			dockerGiB?: number;
			recoveryGiB?: number;
			cpuAllowance?: string;
		},
	): Promise<StartInstanceResponse> {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		inst.status = "Running";
		inst.ipv4 = "10.0.0.2";
		inst.cpuAllowance = opts.cpuAllowance ?? null;
		// The real provider pushes this token and waits for agent health;
		// the fake records it and treats the agent as already healthy.
		inst.agentToken = opts.agentToken;
		inst.hostname = opts.hostname;
		inst.previewHostSuffix = opts.previewHostSuffix;
		inst.timezone = opts.timezone;
		if (opts.recoveryGiB !== undefined && inst.recoveryGiB === null) {
			inst.recoveryGiB = opts.recoveryGiB;
		}
		return { ipv4: "10.0.0.2" };
	}

	async stop(
		name: string,
		_opts: { timeoutSeconds: number },
	): Promise<StopInstanceResponse> {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		if (this.stopShouldHang) {
			this.stopShouldHang = false;
			inst.status = "Stopped";
			inst.ipv4 = null;
			return { forced: true };
		}
		inst.status = "Stopped";
		inst.ipv4 = null;
		return { forced: false };
	}

	async list(): Promise<InstanceStatus[]> {
		this.checkError();
		return [...this.instances.values()].map((inst) => ({
			name: inst.name,
			status: inst.status,
			ipv4: inst.ipv4,
		}));
	}

	async healthy(): Promise<boolean> {
		return true;
	}

	async resetDocker(name: string, opts: { dockerGiB: number }): Promise<void> {
		const inst = this.stoppedInstance(name);
		inst.dockerGeneration += 1;
		inst.quota = { ...inst.quota, dockerGiB: opts.dockerGiB };
	}

	async rebuild(
		name: string,
		opts: { resetDocker: boolean; dockerGiB: number },
	): Promise<RebuildInstanceResponse> {
		const inst = this.stoppedInstance(name);
		if (opts.resetDocker) {
			await this.resetDocker(name, { dockerGiB: opts.dockerGiB });
		}
		inst.rebuilds += 1;
		inst.imageFingerprint = "def456";
		return { imageFingerprint: inst.imageFingerprint };
	}

	private stoppedInstance(name: string): FakeInstance {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		if (inst.status !== "Stopped") {
			throw new InstanceNotStoppedError(name, inst.status);
		}
		return inst;
	}

	async hostSnapshot(): Promise<HostSnapshot> {
		this.checkError();
		return {
			observedAt: new Date().toISOString(),
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
			instances: [...this.instances.values()].map((inst) => ({
				name: inst.name,
				imageFingerprint: inst.imageFingerprint,
				imageSerial: "2026.09.9",
			})),
			rates: null,
		};
	}

	async growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
	): Promise<GrowVolumesResponse> {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		if (sizes.homeGiB < inst.quota.homeGiB || sizes.dockerGiB < inst.quota.dockerGiB) {
			throw new IncusError("BAD_REQUEST", "Storage can only be increased.");
		}
		inst.quota = { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };
		return { ...inst.quota };
	}

	async usage(): Promise<InstanceUsage[]> {
		this.checkError();
		return [...this.instances.values()]
			.filter((inst) => inst.status === "Running")
			.map((inst) => ({
				name: inst.name,
				cpuUsageNs: 0,
				bootMarker: 1,
				cpuLimit: 4,
				memoryBytes: 2 ** 30,
				memoryLimitBytes: 6 * 2 ** 30,
				cpuAllowance: inst.cpuAllowance,
			}));
	}

	async setCpuAllowance(name: string, allowance: string | null): Promise<void> {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		inst.cpuAllowance = allowance;
	}

	/** What `processes` answers for a running instance. */
	processRows: InstanceProcess[] = [
		{
			pid: 1,
			uid: 0,
			name: "systemd",
			startTicks: 1,
			cpuPercent: 0,
			residentBytes: 12 * 2 ** 20,
			protected: true,
		},
		{
			pid: 4242,
			uid: 1000,
			name: "node",
			startTicks: 90_000,
			cpuPercent: 97.5,
			residentBytes: 300 * 2 ** 20,
			protected: false,
		},
	];

	async processes(name: string): Promise<InstanceProcess[]> {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		if (inst.status !== "Running") {
			throw new IncusError("OPERATION_FAILED", `instance ${name} is not running`);
		}
		return this.processRows;
	}

	/** Add a custom volume, as the backup channel's import would. */
	addVolume(name: string, createdAt = new Date().toISOString()): void {
		if (!this.volumes.has(name)) {
			this.volumes.set(name, { createdAt, snapshots: new Map() });
		}
	}

	private existingInstance(name: string): FakeInstance {
		this.validate(name);
		this.checkError();
		const inst = this.instances.get(name);
		if (!inst) {
			throw new IncusError("NOT_FOUND", `instance ${name} not found`);
		}
		return inst;
	}

	async setLimits(name: string, limits: SetInstanceLimitsRequest): Promise<void> {
		const inst = this.existingInstance(name);
		if (limits.cpu !== null && limits.cpu > this.hostCpuCount) {
			throw new IncusError("BAD_REQUEST", `the host has ${this.hostCpuCount} CPUs`);
		}
		inst.limits = { ...limits };
	}

	async addedPackages(name: string): Promise<AddedPackagesResponse> {
		const inst = this.existingInstance(name);
		const file = inst.addedPackagesFile;
		if (file?.type !== "file") {
			throw new IncusError("NOT_FOUND", "no added-packages list");
		}
		if (Buffer.byteLength(file.content) > ADDED_PACKAGES_MAX_BYTES) {
			throw new IncusError("BAD_REQUEST", "the added-packages list is over 64 KiB");
		}
		return parseAddedPackages(file.content);
	}

	async keptVolumes(): Promise<KeptVolumesResponse> {
		this.checkError();
		const result: KeptVolumesResponse = { snapshots: [], keptHomes: [] };
		for (const [volume, info] of this.volumes) {
			if (KeptHomeVolumeName.safeParse(volume).success) {
				result.keptHomes.push({
					volume,
					instance: volume.slice(0, "ws-".length + 24),
					createdAt: info.createdAt,
				});
				continue;
			}
			if (!WorkspaceVolumeName.safeParse(volume).success) continue;
			for (const [name, createdAt] of info.snapshots) {
				if (PreChangeSnapshotName.safeParse(name).success) {
					result.snapshots.push({ volume, name, createdAt });
				}
			}
		}
		return result;
	}

	async deleteSnapshot(volume: string, snapshot: string): Promise<void> {
		if (
			!WorkspaceVolumeName.safeParse(volume).success ||
			!PreChangeSnapshotName.safeParse(snapshot).success
		) {
			throw new IncusError("BAD_REQUEST", "only pre-change snapshots can be deleted");
		}
		this.checkError();
		if (!this.volumes.get(volume)?.snapshots.delete(snapshot)) {
			throw new IncusError("NOT_FOUND", `snapshot ${volume}/${snapshot} not found`);
		}
	}

	async deleteKeptHome(volume: string): Promise<void> {
		if (!KeptHomeVolumeName.safeParse(volume).success) {
			throw new IncusError("BAD_REQUEST", "only kept homes can be deleted");
		}
		this.checkError();
		if (!this.volumes.has(volume)) {
			throw new IncusError("NOT_FOUND", `volume ${volume} not found`);
		}
		if ([...this.instances.values()].some((inst) => inst.homeVolume === volume)) {
			throw new VolumeInUseError(volume);
		}
		this.volumes.delete(volume);
	}

	async replaceHome(name: string): Promise<ReplaceHomeResponse> {
		const inst = this.stoppedInstance(name);
		const importVolume = `${name}-home-import`;
		const imported = this.volumes.get(importVolume);
		if (!imported) {
			throw new IncusError("NOT_FOUND", `volume ${importVolume} not found`);
		}
		const kept = `${name}-home-replaced-${Math.floor(Date.now() / 1000)}`;
		const home = this.volumes.get(`${name}-home`);
		if (home) this.volumes.set(kept, home);
		this.volumes.set(`${name}-home`, imported);
		this.volumes.delete(importVolume);
		inst.homeVolume = `${name}-home`;
		return { kept };
	}
}
