import { expect, test } from "vitest";
import { AgentError } from "./agent.js";
import {
	CreateInstanceRequest,
	RebuildInstanceRequest,
	RebuildInstanceResponse,
	ResetDockerRequest,
	StartInstanceRequest,
} from "./controller.js";
import {
	AgentCreateRecoveryPointRequest,
	AgentCreateRecoveryPointResponse,
	AgentRestoreRecoveryPointRequest,
	DEFAULT_RECOVERY_EXCLUDES,
	RecoveryPoint,
	RecoveryPointList,
	RestoreRecoveryPointRequest,
	WORKSPACEIGNORE_FILE,
} from "./recovery.js";
import { WorkspaceUsage } from "./usage.js";
import { ApiError, PendingOperation, RebuildWorkspaceRequest } from "./workspace.js";

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

const POINT = {
	id: ID,
	projectId: PROJECT,
	createdAt: "2026-09-22T10:00:00.000Z",
	reason: "periodic",
	sizeBytes: 1024,
	expiresAt: "2026-10-06T10:00:00.000Z",
} as const;

test("RecoveryPoint round-trips every reason", () => {
	for (const reason of [
		"periodic",
		"manual",
		"before-archive",
		"before-restore",
		"before-rebuild",
		"agent-session",
	] as const) {
		const point = { ...POINT, reason };
		expect(RecoveryPoint.parse(point)).toEqual(point);
	}
});

test("RecoveryPoint rejects an unknown reason and a non-uuid id", () => {
	expect(RecoveryPoint.safeParse({ ...POINT, reason: "hourly" }).success).toBe(false);
	expect(RecoveryPoint.safeParse({ ...POINT, id: "not-a-uuid" }).success).toBe(false);
	expect(RecoveryPoint.safeParse({ ...POINT, projectId: "../x" }).success).toBe(false);
});

test("RecoveryPointList round-trips with usage", () => {
	const list = { points: [POINT], usage: { usedBytes: 1024, quotaBytes: 3 * 2 ** 30 } };
	expect(RecoveryPointList.parse(list)).toEqual(list);
});

test("RestoreRecoveryPointRequest takes an optional skipSafetyPoint only", () => {
	expect(RestoreRecoveryPointRequest.parse({})).toEqual({});
	expect(RestoreRecoveryPointRequest.parse({ skipSafetyPoint: true })).toEqual({
		skipSafetyPoint: true,
	});
	expect(RestoreRecoveryPointRequest.safeParse({ force: true }).success).toBe(false);
});

test("the default exclusions are the SPEC 15.5 list", () => {
	expect(DEFAULT_RECOVERY_EXCLUDES).toEqual([
		"node_modules/",
		".venv/",
		"dist/",
		"build/",
		"target/",
		"__pycache__/",
	]);
	expect(WORKSPACEIGNORE_FILE).toBe(".workspaceignore");
});

test("AgentCreateRecoveryPointRequest requires uuids and a hex fingerprint", () => {
	const body = { projectId: PROJECT, pointId: ID, skipIfFingerprint: HASH };
	expect(AgentCreateRecoveryPointRequest.parse(body)).toEqual(body);
	expect(
		AgentCreateRecoveryPointRequest.safeParse({ projectId: PROJECT, pointId: "x" })
			.success,
	).toBe(false);
	expect(
		AgentCreateRecoveryPointRequest.safeParse({ ...body, skipIfFingerprint: "abc" })
			.success,
	).toBe(false);
});

test("AgentCreateRecoveryPointResponse is created or skipped", () => {
	const created = { created: true, sizeBytes: 10, sha256: HASH, fingerprint: HASH };
	expect(AgentCreateRecoveryPointResponse.parse(created)).toEqual(created);
	const skipped = { created: false, fingerprint: HASH };
	expect(AgentCreateRecoveryPointResponse.parse(skipped)).toEqual(skipped);
	expect(
		AgentCreateRecoveryPointResponse.safeParse({ created: true, fingerprint: HASH })
			.success,
	).toBe(false);
});

test("AgentRestoreRecoveryPointRequest requires a project uuid and a sha256", () => {
	const body = { projectId: PROJECT, sha256: HASH };
	expect(AgentRestoreRecoveryPointRequest.parse(body)).toEqual(body);
	expect(
		AgentRestoreRecoveryPointRequest.safeParse({ projectId: PROJECT, sha256: "zz" })
			.success,
	).toBe(false);
});

test("the agent and API accept the new error codes", () => {
	for (const code of ["BUSY", "STORAGE_FULL", "RECOVERY_POINT_INVALID"]) {
		expect(AgentError.safeParse({ error: { code, message: "m" } }).success).toBe(true);
	}
	for (const code of ["BUSY", "STORAGE_FULL", "OPERATION_PENDING"]) {
		expect(ApiError.safeParse({ code, message: "m" }).success).toBe(true);
	}
});

test("PendingOperation accepts the three operations only", () => {
	for (const op of ["reset-docker", "rebuild", "rebuild-reset-docker"]) {
		expect(PendingOperation.parse(op)).toBe(op);
	}
	expect(PendingOperation.safeParse("reinstall").success).toBe(false);
});

test("RebuildWorkspaceRequest requires resetDocker", () => {
	expect(RebuildWorkspaceRequest.parse({ resetDocker: true })).toEqual({
		resetDocker: true,
	});
	expect(RebuildWorkspaceRequest.safeParse({}).success).toBe(false);
	expect(
		RebuildWorkspaceRequest.safeParse({ resetDocker: false, extra: 1 }).success,
	).toBe(false);
});

test("controller maintenance bodies round-trip", () => {
	expect(ResetDockerRequest.parse({ dockerGiB: 20 })).toEqual({ dockerGiB: 20 });
	expect(RebuildInstanceRequest.parse({ resetDocker: false, dockerGiB: 20 })).toEqual({
		resetDocker: false,
		dockerGiB: 20,
	});
	expect(RebuildInstanceResponse.parse({ imageFingerprint: "abc" })).toEqual({
		imageFingerprint: "abc",
	});
	expect(ResetDockerRequest.safeParse({ dockerGiB: 0 }).success).toBe(false);
});

test("CreateInstanceRequest requires recoveryGiB; StartInstanceRequest may omit it", () => {
	expect(
		CreateInstanceRequest.safeParse({ name: "ws-a", homeGiB: 25, dockerGiB: 20 })
			.success,
	).toBe(false);
	expect(
		CreateInstanceRequest.safeParse({
			name: "ws-a",
			homeGiB: 25,
			dockerGiB: 20,
			recoveryGiB: 3,
		}).success,
	).toBe(true);
	const start = {
		agentToken: "0".repeat(64),
		hostname: "ws-a",
		previewHostSuffix: "preview.localhost",
		timezone: "America/New_York",
	};
	expect(StartInstanceRequest.parse(start).recoveryGiB).toBeUndefined();
	expect(StartInstanceRequest.parse({ ...start, recoveryGiB: 3 }).recoveryGiB).toBe(3);
});

test("WorkspaceUsage carries three storage classes, each possibly null", () => {
	const usage = {
		observedAt: "2026-09-22T10:00:00.000Z",
		cpuPercent: null,
		memory: { usedBytes: 1, totalBytes: 2 },
		disk: { usedBytes: 1, totalBytes: 2 },
		network: { receiveBytesPerSecond: null, transmitBytesPerSecond: null },
		processes: [],
		storage: { home: { usedBytes: 1, totalBytes: 2 }, docker: null, recovery: null },
	};
	expect(WorkspaceUsage.parse(usage)).toEqual(usage);
	const { storage: _storage, ...withoutStorage } = usage;
	expect(WorkspaceUsage.safeParse(withoutStorage).success).toBe(false);
});
