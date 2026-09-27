import { describe, expect, test } from "vitest";
import {
	ControllerError,
	CpuAllowance,
	DebianPackageName,
	InstanceUsage,
	InstanceUsageResponse,
	KeptHomeVolumeName,
	PreChangeSnapshotName,
	SetCpuAllowanceRequest,
	SetInstanceLimitsRequest,
	StartInstanceRequest,
	WorkspaceVolumeName,
} from "./controller.js";

describe("the resource guard's controller contracts (ADR 0032)", () => {
	const usage = {
		name: "ws-alice",
		cpuUsageNs: 123_456_789_000,
		bootMarker: 31337,
		cpuLimit: 4,
		memoryBytes: 512 * 1024 ** 2,
		memoryLimitBytes: 6 * 1024 ** 3,
		cpuAllowance: null,
	};

	test("a usage listing round-trips, with or without an allowance", () => {
		const body = {
			instances: [usage, { ...usage, name: "ws-bob", cpuAllowance: "100ms/100ms" }],
		};
		expect(InstanceUsageResponse.parse(body)).toEqual(body);
		// Whatever Incus holds is reported, so the worker can remove a stray one.
		expect(InstanceUsage.parse({ ...usage, cpuAllowance: "25%" }).cpuAllowance).toBe(
			"25%",
		);
	});

	test("a usage row refuses missing or impossible numbers", () => {
		expect(InstanceUsage.safeParse({ ...usage, cpuLimit: 0 }).success).toBe(false);
		expect(InstanceUsage.safeParse({ ...usage, memoryBytes: -1 }).success).toBe(false);
		expect(InstanceUsage.safeParse({ ...usage, memoryLimitBytes: 0 }).success).toBe(
			false,
		);
		expect(InstanceUsage.safeParse({ ...usage, bootMarker: 0 }).success).toBe(false);
		expect(InstanceUsage.safeParse({ ...usage, bootMarker: null }).success).toBe(true);
		const { cpuUsageNs: _dropped, ...missing } = usage;
		expect(InstanceUsage.safeParse(missing).success).toBe(false);
	});

	test("a CPU counter above 2^53 still parses, so one instance cannot fail the listing", () => {
		const huge = { ...usage, cpuUsageNs: 2 ** 60 };
		expect(InstanceUsageResponse.safeParse({ instances: [usage, huge] }).success).toBe(
			true,
		);
	});

	test("a usage row drops anything beyond the totals", () => {
		const parsed = InstanceUsage.parse({ ...usage, processes: ["xmrig"] });
		expect(parsed).toEqual(usage);
	});

	test("an allowance is a time slice of 1 to 6 digits over 100ms", () => {
		for (const ok of ["100ms/100ms", "1ms/100ms", "400ms/100ms", "999999ms/100ms"]) {
			expect(CpuAllowance.safeParse(ok).success, ok).toBe(true);
		}
		for (const bad of [
			"25%",
			"0ms/100ms",
			"1000000ms/100ms",
			"100ms/50ms",
			"100ms",
			" 100ms/100ms",
			"100ms/100ms\n",
			"",
		]) {
			expect(CpuAllowance.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
	});

	test("setting the allowance takes a time slice or null, and nothing else", () => {
		expect(SetCpuAllowanceRequest.parse({ allowance: "100ms/100ms" })).toEqual({
			allowance: "100ms/100ms",
		});
		expect(SetCpuAllowanceRequest.parse({ allowance: null })).toEqual({
			allowance: null,
		});
		expect(SetCpuAllowanceRequest.safeParse({ allowance: "25%" }).success).toBe(false);
		expect(SetCpuAllowanceRequest.safeParse({}).success).toBe(false);
		expect(
			SetCpuAllowanceRequest.safeParse({ allowance: null, name: "ws-alice" }).success,
		).toBe(false);
	});

	test("a full storage pool has its own error code, apart from a full volume", () => {
		expect(
			ControllerError.parse({ code: "POOL_FULL", message: "pool is 91% full" }).code,
		).toBe("POOL_FULL");
	});
});

describe("the admin-operations controller contracts (SPEC.md §19.3, §20.1)", () => {
	test("limits take whole numbers in range, or null, and nothing else", () => {
		expect(
			SetInstanceLimitsRequest.safeParse({ cpu: 64, memoryMiB: 512, processes: 32768 })
				.success,
		).toBe(true);
		expect(
			SetInstanceLimitsRequest.safeParse({
				cpu: null,
				memoryMiB: null,
				processes: null,
			}).success,
		).toBe(true);
		for (const bad of [
			{ cpu: 65, memoryMiB: null, processes: null },
			{ cpu: 1.5, memoryMiB: null, processes: null },
			{ cpu: null, memoryMiB: 262145, processes: null },
			{ cpu: null, memoryMiB: null, processes: 499 },
			{ cpu: null, memoryMiB: null },
			{ cpu: null, memoryMiB: null, processes: null, profile: "x" },
		]) {
			expect(SetInstanceLimitsRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(
				false,
			);
		}
	});

	test("only pre-change snapshots of workspace volumes and kept homes match", () => {
		const ws = "ws-0123456789abcdef01234567";
		expect(PreChangeSnapshotName.safeParse("pre-upgrade-2").success).toBe(true);
		for (const bad of [
			"portikus-backup",
			"pre-",
			"pre-A",
			"pre-a/b",
			`pre-${"a".repeat(64)}`,
		]) {
			expect(PreChangeSnapshotName.safeParse(bad).success, bad).toBe(false);
		}
		expect(WorkspaceVolumeName.safeParse(`${ws}-recovery`).success).toBe(true);
		for (const bad of [`${ws}-home-import`, "ws-abc-home", `${ws}-root`]) {
			expect(WorkspaceVolumeName.safeParse(bad).success, bad).toBe(false);
		}
		expect(KeptHomeVolumeName.safeParse(`${ws}-home-replaced-1790000000`).success).toBe(
			true,
		);
		for (const bad of [
			`${ws}-home`,
			`${ws}-home-replaced-`,
			`${ws}-home-replaced-1/x`,
		]) {
			expect(KeptHomeVolumeName.safeParse(bad).success, bad).toBe(false);
		}
	});

	test("a package name is Debian's form and nothing a shell would read", () => {
		for (const good of ["htop", "g++", "python3.13-venv", "libc6"]) {
			expect(DebianPackageName.safeParse(good).success, good).toBe(true);
		}
		for (const bad of ["a", "Htop", "-x", "htop;reboot", "a b", "pkg:amd64", ""]) {
			expect(DebianPackageName.safeParse(bad).success, bad).toBe(false);
		}
	});

	test("a start may carry a held allowance, only as a time slice", () => {
		const start = {
			agentToken: "a".repeat(64),
			hostname: "tw7",
			previewHostSuffix: "p.example.edu",
			timezone: "America/New_York",
		};
		expect(
			StartInstanceRequest.parse({ ...start, cpuAllowance: "50ms/100ms" }),
		).toMatchObject({
			cpuAllowance: "50ms/100ms",
		});
		expect(
			StartInstanceRequest.safeParse({ ...start, cpuAllowance: "50%" }).success,
		).toBe(false);
	});
});
