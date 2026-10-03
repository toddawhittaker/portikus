import type { Workspace } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { signatureOf } from "./ws.js";

const workspace: Workspace = {
	id: "22222222-2222-4222-8222-222222222222",
	ownerUserId: "11111111-1111-4111-8111-111111111111",
	label: "tw7",
	state: "running",
	desiredState: "running",
	incusInstanceName: "ws-abc",
	imageVersion: null,
	quotaConfig: { homeGiB: 25, dockerGiB: 20 },
	pendingOperation: null,
	archivedAt: null,
	errorCode: null,
	errorMessage: null,
	activeConnections: 0,
	lastActiveConnectionAt: null,
	shutdownDeadline: null,
	cpuThrottle: null,
	memoryFlag: null,
	idleStopAt: null,
	lastActivityAt: null,
	keepRunningUntil: null,
	keepRunningMaxHours: 12,
	stateVerified: true,
	createdAt: "2026-09-21T00:00:00.000Z",
	updatedAt: "2026-09-21T00:00:00.000Z",
};

describe("the live workspace push signature", () => {
	const before = signatureOf(workspace);

	test.each([
		["label", { label: "tw8" }],
		["imageVersion", { imageVersion: "2026.10.1" }],
		["quotaConfig", { quotaConfig: { homeGiB: 30, dockerGiB: 20 } }],
		["errorMessage", { errorMessage: "disk full" }],
		["state", { state: "stopping" }],
		["stateVerified", { stateVerified: false }],
	] as const)("changes when %s changes", (_field, change) => {
		expect(signatureOf({ ...workspace, ...change } as Workspace)).not.toBe(before);
	});

	test("does not change when only the moving times change", () => {
		const later = "2026-10-02T12:00:00.000Z";
		expect(
			signatureOf({
				...workspace,
				lastActivityAt: later,
				lastActiveConnectionAt: later,
				updatedAt: later,
			}),
		).toBe(before);
	});
});
