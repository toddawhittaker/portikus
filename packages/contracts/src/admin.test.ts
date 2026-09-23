import { describe, expect, test } from "vitest";
import {
	AdminWorkspaceDetail,
	AuditPage,
	AuditQuery,
	HealthReport,
	isQuotaGrowOnly,
	MAX_QUOTA_GIB,
	STALE_AFTER_DAYS,
	UpdateQuotaRequest,
} from "./admin.js";
import { AdminUser } from "./settings.js";
import { ApiErrorCode, Workspace } from "./workspace.js";

const now = "2026-09-22T12:00:00.000Z";
const uuid = "00000000-0000-4000-8000-000000000001";

const workspace: Workspace = {
	id: uuid,
	ownerUserId: uuid,
	label: "alice",
	state: "running",
	desiredState: "running",
	incusInstanceName: "ws-alice",
	imageVersion: "abc",
	quotaConfig: { homeGiB: 25, dockerGiB: 20 },
	pendingOperation: null,
	errorCode: null,
	errorMessage: null,
	activeConnections: 1,
	lastActiveConnectionAt: now,
	shutdownDeadline: null,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
};

const event = {
	id: 7,
	at: now,
	actor: `user:${uuid}`,
	actorName: "Carol",
	action: "workspace.stop_requested",
	target: `workspace:${uuid}`,
	result: "success",
	metadata: { from: 25 },
};

const detail = {
	workspace,
	owner: {
		id: uuid,
		displayName: "Alice",
		email: "alice@example.edu",
		preferredUsername: "alice",
		disabledAt: null,
	},
	quotaApplied: { homeGiB: 25, dockerGiB: 20 },
	image: { label: "2026.09.9", fingerprint: "abc", current: true },
	agent: "answering",
	usage: {
		cpuPercent: 3,
		memory: { usedBytes: 1, totalBytes: 2 },
		disk: { usedBytes: 1, totalBytes: 2 },
	},
	storage: null,
	ports: [
		{ port: 5173, command: "node", previewReachability: "reachable", system: false },
	],
	previewSessions: [{ port: 5173, openedAt: now }],
	recentAudit: [event],
	capabilities: { rebuild: false, resetDocker: false },
};

describe("admin contracts", () => {
	test("the stale threshold is 30 days", () => {
		expect(STALE_AFTER_DAYS).toBe(30);
	});

	test("a workspace detail round-trips", () => {
		expect(AdminWorkspaceDetail.parse(detail)).toEqual(detail);
	});

	test("the detail refuses a command line or a process list", () => {
		const withCommandLine = {
			...detail,
			ports: [{ ...detail.ports[0], commandLine: "node --token=x" }],
		};
		expect(AdminWorkspaceDetail.safeParse(withCommandLine).success).toBe(false);
		const withProcesses = { ...detail, usage: { ...detail.usage, processes: [] } };
		expect(AdminWorkspaceDetail.safeParse(withProcesses).success).toBe(false);
	});

	test("an account row with markers and a workspace round-trips", () => {
		const user = {
			id: uuid,
			displayName: "Alice",
			email: "alice@example.edu",
			role: "student",
			disabledAt: null,
			shutdownGraceSeconds: null,
			preferredUsername: "alice",
			issuer: "https://idp.example.edu",
			lastLoginAt: now,
			markers: { disabled: false, archived: false, duplicateEmail: true, stale: false },
			workspace: {
				id: uuid,
				label: "alice",
				state: "rebuilding",
				desiredState: "running",
				activeConnections: 0,
				lastActiveConnectionAt: null,
				quotaConfig: { homeGiB: 30, dockerGiB: 20 },
				quotaApplied: { homeGiB: 25, dockerGiB: 20 },
				image: {
					label: "abcdef123456",
					fingerprint: "abcdef123456789",
					current: false,
				},
				archivedAt: null,
			},
		};
		expect(AdminUser.parse(user)).toEqual(user);
	});

	test("a quota request is whole GiB, positive, and capped", () => {
		expect(UpdateQuotaRequest.parse({ homeGiB: 30, dockerGiB: 20 })).toEqual({
			homeGiB: 30,
			dockerGiB: 20,
		});
		expect(UpdateQuotaRequest.safeParse({ homeGiB: 0, dockerGiB: 20 }).success).toBe(
			false,
		);
		expect(
			UpdateQuotaRequest.safeParse({ homeGiB: MAX_QUOTA_GIB + 1, dockerGiB: 20 })
				.success,
		).toBe(false);
		expect(UpdateQuotaRequest.safeParse({ homeGiB: 1.5, dockerGiB: 20 }).success).toBe(
			false,
		);
		expect(
			UpdateQuotaRequest.safeParse({ homeGiB: 30, dockerGiB: 20, cpu: 2 }).success,
		).toBe(false);
	});

	test("storage can only grow", () => {
		const from = { homeGiB: 25, dockerGiB: 20 };
		expect(isQuotaGrowOnly(from, { homeGiB: 25, dockerGiB: 20 })).toBe(true);
		expect(isQuotaGrowOnly(from, { homeGiB: 30, dockerGiB: 20 })).toBe(true);
		expect(isQuotaGrowOnly(from, { homeGiB: 24, dockerGiB: 40 })).toBe(false);
		expect(isQuotaGrowOnly(from, { homeGiB: 40, dockerGiB: 19 })).toBe(false);
	});

	test("an audit query coerces the page cursor from the query string", () => {
		expect(AuditQuery.parse({ before: "120", action: "workspace." })).toEqual({
			before: 120,
			action: "workspace.",
		});
		expect(AuditQuery.safeParse({ workspace: "nope" }).success).toBe(false);
		expect(AuditQuery.safeParse({ before: "0" }).success).toBe(false);
	});

	test("an audit page round-trips", () => {
		const page = { events: [event], nextBefore: null };
		expect(AuditPage.parse(page)).toEqual(page);
	});

	test("a health report round-trips", () => {
		const report = {
			sampledAt: now,
			workerStale: false,
			controller: { reachable: true, errorCode: null },
			host: {
				loadAverage: [0.5, 0.4, 0.3],
				cpuCount: 8,
				memory: { usedBytes: 1, totalBytes: 2 },
				pool: { usedBytes: 1, totalBytes: 2 },
				profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
				image: { fingerprint: "abc", serial: "2026.09.9" },
			},
			workspacesByState: { running: 2, stopped: 1 },
			agents: { answering: 2, running: 2 },
			last24h: {
				startFailures: 0,
				stopFailures: 0,
				forcedStops: 0,
				provisionFailures: 0,
				controllerOutages: 0,
				signInFailures: 1,
				previewRefusals: 3,
			},
			series: [
				{
					at: now,
					poolUsedBytes: 1,
					poolTotalBytes: 2,
					memoryUsedBytes: 1,
					memoryTotalBytes: 2,
					load1: 0.5,
				},
			],
		};
		expect(HealthReport.parse(report)).toEqual(report);
	});

	test("archived workspaces have their own error code", () => {
		expect(ApiErrorCode.parse("WORKSPACE_ARCHIVED")).toBe("WORKSPACE_ARCHIVED");
		expect(Workspace.parse({ ...workspace, archivedAt: now }).archivedAt).toBe(now);
	});
});
