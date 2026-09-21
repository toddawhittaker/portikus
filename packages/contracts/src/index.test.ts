import { expect, test } from "vitest";
import {
	AdminWorkspaceList,
	ApiError,
	AuthUser,
	ControllerError,
	CreateInstanceRequest,
	CreateInstanceResponse,
	CreateWorkspaceRequest,
	HealthResponse,
	InstanceName,
	InstanceStatus,
	ListInstancesResponse,
	StartInstanceResponse,
	StopInstanceRequest,
	StopInstanceResponse,
	Workspace,
} from "./index.js";

const sampleWorkspace = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	ownerUserId: "550e8400-e29b-41d4-a716-446655440111",
	label: "tw7",
	state: "running" as const,
	desiredState: "running" as const,
	incusInstanceName: "ws-abc123",
	imageVersion: "1.0.0",
	quotaConfig: { homeGiB: 25, dockerGiB: 20 },
	errorCode: null,
	errorMessage: null,
	activeConnections: 2,
	lastActiveConnectionAt: null,
	shutdownDeadline: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

test("accepts a well-formed health response", () => {
	const parsed = HealthResponse.parse({
		status: "ok",
		service: "api",
		uptimeSeconds: 1.5,
	});
	expect(parsed.service).toBe("api");
});

test("rejects a health response with a negative uptime", () => {
	const result = HealthResponse.safeParse({
		status: "ok",
		service: "api",
		uptimeSeconds: -1,
	});
	expect(result.success).toBe(false);
});

test("Workspace round-trips a complete response", () => {
	const now = new Date().toISOString();
	const input = {
		id: "550e8400-e29b-41d4-a716-446655440000",
		ownerUserId: "550e8400-e29b-41d4-a716-446655440111",
		label: "tw7",
		state: "running" as const,
		desiredState: "running" as const,
		incusInstanceName: "ws-abc123",
		imageVersion: "1.0.0",
		quotaConfig: { homeGiB: 25, dockerGiB: 20 },
		errorCode: null,
		errorMessage: null,
		activeConnections: 2,
		lastActiveConnectionAt: now,
		shutdownDeadline: null,
		createdAt: now,
		updatedAt: now,
	};
	expect(Workspace.parse(input)).toEqual(input);
});

test("Workspace rejects a non-uuid owner", () => {
	expect(
		Workspace.safeParse({ ...sampleWorkspace, ownerUserId: "user-1" }).success,
	).toBe(false);
});

test("CreateWorkspaceRequest accepts an empty body", () => {
	expect(CreateWorkspaceRequest.parse({})).toEqual({});
});

test("CreateWorkspaceRequest rejects any property", () => {
	expect(CreateWorkspaceRequest.safeParse({ ownerUserId: "x" }).success).toBe(false);
});

test("AuthUser round-trips and allows a null email", () => {
	const input = {
		id: "550e8400-e29b-41d4-a716-446655440111",
		email: null,
		displayName: "Alice",
		role: "student" as const,
	};
	expect(AuthUser.parse(input)).toEqual(input);
});

test("AuthUser rejects an unknown role", () => {
	const result = AuthUser.safeParse({
		id: "550e8400-e29b-41d4-a716-446655440111",
		email: "a@example.com",
		displayName: "Alice",
		role: "instructor",
	});
	expect(result.success).toBe(false);
});

test("AdminWorkspaceList round-trips", () => {
	const input = { workspaces: [sampleWorkspace] };
	expect(AdminWorkspaceList.parse(input)).toEqual(input);
});

test("ApiErrorCode covers the authorization codes", () => {
	expect(ApiError.safeParse({ code: "UNAUTHORIZED", message: "" }).success).toBe(true);
	expect(ApiError.safeParse({ code: "FORBIDDEN", message: "" }).success).toBe(true);
	expect(
		ApiError.safeParse({ code: "CONNECTION_NOT_FOUND", message: "" }).success,
	).toBe(false);
});

test("ApiError round-trips", () => {
	const input = { code: "WORKSPACE_NOT_FOUND" as const, message: "not found" };
	expect(ApiError.parse(input)).toEqual(input);
});

test("InstanceName accepts ws- plus 24 hex chars", () => {
	expect(InstanceName.parse("ws-aabbccdd11223344aabbcc")).toBe(
		"ws-aabbccdd11223344aabbcc",
	);
});

test("InstanceName rejects uppercase", () => {
	expect(InstanceName.safeParse("ws-AABB").success).toBe(false);
});

test("InstanceName rejects leading digit", () => {
	expect(InstanceName.safeParse("1ws-abc").success).toBe(false);
});

test("InstanceName rejects length 32 (exceeds 31 chars)", () => {
	// 32 characters total: 'a' + 31 more
	const name = `a${"b".repeat(31)}`;
	expect(name.length).toBe(32);
	expect(InstanceName.safeParse(name).success).toBe(false);
});

test("CreateInstanceRequest round-trips", () => {
	const input = { name: "ws-abc123", homeGiB: 25, dockerGiB: 20 };
	expect(CreateInstanceRequest.parse(input)).toEqual(input);
});

test("CreateInstanceResponse round-trips", () => {
	const input = {
		created: true,
		imageFingerprint: "sha256:abc",
		quota: { homeGiB: 25, dockerGiB: 20 },
	};
	expect(CreateInstanceResponse.parse(input)).toEqual(input);
});

test("StartInstanceResponse round-trips", () => {
	const input = { ipv4: "10.99.0.5" };
	expect(StartInstanceResponse.parse(input)).toEqual(input);
});

test("StopInstanceRequest round-trips", () => {
	const input = { timeoutSeconds: 30 };
	expect(StopInstanceRequest.parse(input)).toEqual(input);
});

test("StopInstanceResponse round-trips", () => {
	const input = { forced: true };
	expect(StopInstanceResponse.parse(input)).toEqual(input);
});

test("InstanceStatus round-trips", () => {
	const input = { name: "ws-abc", status: "Running" as const, ipv4: null };
	expect(InstanceStatus.parse(input)).toEqual(input);
});

test("ListInstancesResponse round-trips an array", () => {
	const input = [
		{ name: "ws-a", status: "Running" as const, ipv4: "10.0.0.1" },
		{ name: "ws-b", status: "Stopped" as const, ipv4: null },
	];
	expect(ListInstancesResponse.parse(input)).toEqual(input);
});

test("ControllerError round-trips", () => {
	const input = { code: "NOT_FOUND" as const, message: "instance not found" };
	expect(ControllerError.parse(input)).toEqual(input);
});

test("ApiErrorCode covers the terminal and agent codes", () => {
	expect(ApiError.safeParse({ code: "TERMINAL_LIMIT", message: "" }).success).toBe(
		true,
	);
	expect(ApiError.safeParse({ code: "TERMINAL_NOT_FOUND", message: "" }).success).toBe(
		true,
	);
	expect(ApiError.safeParse({ code: "AGENT_UNAVAILABLE", message: "" }).success).toBe(
		true,
	);
});
