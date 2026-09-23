import {
	type ControllerErrorCode,
	type CreateInstanceResponse,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
	InstanceName,
	type InstanceStatus,
	type StartInstanceResponse,
	type StopInstanceResponse,
} from "@portikus/contracts";
import { IncusError } from "./incus.js";
import type { WorkspaceProvider } from "./provider.js";

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
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
	readonly instances = new Map<string, FakeInstance>();
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
		sizes: { homeGiB: number; dockerGiB: number },
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
		const inst: FakeInstance = {
			name,
			status: "Stopped",
			ipv4: null,
			agentToken: null,
			hostname: null,
			previewHostSuffix: null,
			timezone: null,
			imageFingerprint: "abc123",
			quota: sizes,
		};
		this.instances.set(name, inst);
		return { created: true, imageFingerprint: "abc123", quota: sizes };
	}

	async start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
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
		// The real provider pushes this token and waits for agent health;
		// the fake records it and treats the agent as already healthy.
		inst.agentToken = opts.agentToken;
		inst.hostname = opts.hostname;
		inst.previewHostSuffix = opts.previewHostSuffix;
		inst.timezone = opts.timezone;
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
			},
			profileLimits: { cpu: "2", memory: "4GB", processes: "2000" },
			image: { fingerprint: "abc123", serial: "2026.09.9" },
			instances: [...this.instances.values()].map((inst) => ({
				name: inst.name,
				imageFingerprint: inst.imageFingerprint,
				imageSerial: "2026.09.9",
			})),
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
}
