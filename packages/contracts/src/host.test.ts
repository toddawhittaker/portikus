import { describe, expect, test } from "vitest";
import {
	GrowVolumesRequest,
	GrowVolumesResponse,
	HealthSample,
	HostSnapshot,
} from "./host.js";

const snapshot = {
	observedAt: "2026-09-22T12:00:00.000Z",
	loadAverage: [0.5, 0.4, 0.3],
	cpuCount: 8,
	memory: { usedBytes: 4, totalBytes: 16 },
	pool: { name: "portikus", usedBytes: 10, totalBytes: 100 },
	profileLimits: { cpu: "2", memory: "4GiB", processes: null },
	image: { fingerprint: "abc", serial: "2026.09.9" },
	instances: [{ name: "ws-alice", imageFingerprint: "abc", imageSerial: null }],
};

const rates = {
	cpuPercent: 12.5,
	netRxBytesPerSecond: 1000,
	netTxBytesPerSecond: 500,
	diskReadBytesPerSecond: 0,
	diskWriteBytesPerSecond: 4096,
};

describe("host contracts", () => {
	test("a host snapshot round-trips", () => {
		const withRates = { ...snapshot, rates };
		expect(HostSnapshot.parse(withRates)).toEqual(withRates);
	});

	test("a snapshot from before Epic 19 parses with null rates", () => {
		expect(HostSnapshot.parse(snapshot)).toEqual({ ...snapshot, rates: null });
	});

	test("rates reject a CPU percentage over 100 and negative throughput", () => {
		expect(
			HostSnapshot.safeParse({ ...snapshot, rates: { ...rates, cpuPercent: 101 } })
				.success,
		).toBe(false);
		expect(
			HostSnapshot.safeParse({
				...snapshot,
				rates: { ...rates, netRxBytesPerSecond: -1 },
			}).success,
		).toBe(false);
	});

	test("a sample from before Epic 19 parses with a null running count", () => {
		const old = { controller: { reachable: true, errorCode: null }, host: snapshot };
		expect(HealthSample.parse(old)).toEqual({
			...old,
			host: { ...snapshot, rates: null },
			runningWorkspaces: null,
		});
		const counted = { ...old, host: { ...snapshot, rates }, runningWorkspaces: 3 };
		expect(HealthSample.parse(counted)).toEqual(counted);
	});

	test("a host snapshot needs exactly three load averages", () => {
		expect(HostSnapshot.safeParse({ ...snapshot, loadAverage: [1, 2] }).success).toBe(
			false,
		);
	});

	test("a health sample holds a snapshot, or null when the controller is down", () => {
		const up = {
			controller: { reachable: true, errorCode: null },
			host: { ...snapshot, rates },
			runningWorkspaces: 2,
		};
		expect(HealthSample.parse(up)).toEqual(up);
		const down = {
			controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
			host: null,
			runningWorkspaces: 0,
		};
		expect(HealthSample.parse(down)).toEqual(down);
	});

	test("a grow request is whole positive GiB with nothing extra", () => {
		expect(GrowVolumesRequest.parse({ homeGiB: 30, dockerGiB: 20 })).toEqual({
			homeGiB: 30,
			dockerGiB: 20,
		});
		expect(GrowVolumesRequest.safeParse({ homeGiB: -1, dockerGiB: 20 }).success).toBe(
			false,
		);
		expect(
			GrowVolumesRequest.safeParse({ homeGiB: 30, dockerGiB: 20, pool: "x" }).success,
		).toBe(false);
		expect(GrowVolumesResponse.parse({ homeGiB: 30, dockerGiB: 20 })).toEqual({
			homeGiB: 30,
			dockerGiB: 20,
		});
	});
});
