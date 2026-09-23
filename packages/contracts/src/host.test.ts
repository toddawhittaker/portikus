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

describe("host contracts", () => {
	test("a host snapshot round-trips", () => {
		expect(HostSnapshot.parse(snapshot)).toEqual(snapshot);
	});

	test("a host snapshot needs exactly three load averages", () => {
		expect(HostSnapshot.safeParse({ ...snapshot, loadAverage: [1, 2] }).success).toBe(
			false,
		);
	});

	test("a health sample holds a snapshot, or null when the controller is down", () => {
		const up = { controller: { reachable: true, errorCode: null }, host: snapshot };
		expect(HealthSample.parse(up)).toEqual(up);
		const down = {
			controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
			host: null,
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
