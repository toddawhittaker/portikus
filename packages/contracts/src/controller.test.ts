import { describe, expect, test } from "vitest";
import {
	CpuAllowance,
	InstanceUsage,
	InstanceUsageResponse,
	SetCpuAllowanceRequest,
} from "./controller.js";

describe("the resource guard's controller contracts (ADR 0032)", () => {
	const usage = {
		name: "ws-alice",
		cpuUsageNs: 123_456_789_000,
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
		const { cpuUsageNs: _dropped, ...missing } = usage;
		expect(InstanceUsage.safeParse(missing).success).toBe(false);
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
});
