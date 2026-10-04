import {
	AdminUser,
	AdminUserList,
	AdminWorkspaceDetail,
	type CreateDexUserRequest,
	CreateDexUserResponse,
	DexPasswordResponse,
	PlatformSettings,
	type QuotaConfig,
	type UpdateAdminUserSettingsRequest,
	type UpdateGuardRequest,
	type UpdateLimitsRequest,
	type UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { request } from "../api/request.js";

/** The admin caches' query keys, also used by writes elsewhere that change them. */
export const adminKeys = {
	settings: ["admin", "settings"] as const,
	users: ["admin", "users"] as const,
	workspace: (id: string) => ["admin", "workspace", id] as const,
};

/** The list and the detail panel refresh this often. */
const ADMIN_REFRESH_MS = 5000;

function json(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

/** The platform-wide settings an administrator can change (SPEC.md §6.4). */
export function usePlatformSettings() {
	return useQuery({
		queryKey: adminKeys.settings,
		queryFn: () => request(PlatformSettings, "/admin/settings"),
	});
}

const usersQuery = {
	queryKey: adminKeys.users,
	queryFn: () => request(AdminUserList, "/admin/users"),
};

/** Every account, and whether the site manages Dex users (ADR 0028). */
export function useAdminUsers({ poll = true }: { poll?: boolean } = {}) {
	return useQuery({
		...usersQuery,
		// A Person list needs no 5-second refresh; the Users table does.
		refetchInterval: poll ? ADMIN_REFRESH_MS : false,
	});
}

/**
 * The same list, refreshed only while some workspace has an operation
 * pending, so every admin tab can hear it end without polling all the time.
 */
export function useAdminUsersWhilePending() {
	return useQuery({
		...usersQuery,
		refetchInterval: (query) =>
			query.state.data?.users.some((user) => user.workspace?.pendingOperation)
				? ADMIN_REFRESH_MS
				: false,
	});
}

/** One workspace's detail panel (SPEC.md §20.1). */
export function useAdminWorkspace(id: string | null) {
	return useQuery({
		queryKey: adminKeys.workspace(id ?? ""),
		queryFn: () => request(AdminWorkspaceDetail, `/admin/workspaces/${id}`),
		enabled: id !== null,
		refetchInterval: ADMIN_REFRESH_MS,
	});
}

/**
 * Refetch the Users list the moment the detail panel sees a rebuild or
 * reset finish, so its Old image tag goes without waiting a poll.
 */
export function useRefreshUsersWhenDone(pendingOperation: string | null) {
	const client = useQueryClient();
	const previous = useRef(pendingOperation);
	useEffect(() => {
		if (previous.current !== null && pendingOperation === null) {
			void client.invalidateQueries({ queryKey: adminKeys.users });
		}
		previous.current = pendingOperation;
	}, [client, pendingOperation]);
}

export function useUpdatePlatformSettings() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: UpdatePlatformSettingsRequest) =>
			request(PlatformSettings, "/admin/settings", json("PUT", body)),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["admin"] });
		},
	});
}

export function useUpdateUserSettings() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({
			userId,
			body,
		}: {
			userId: string;
			body: UpdateAdminUserSettingsRequest;
		}) => request(AdminUser, `/admin/users/${userId}/settings`, json("PUT", body)),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["admin"] });
		},
	});
}

/**
 * Every admin action is a POST or PUT whose answer the page does not read:
 * it refetches the list and the detail instead.
 */
function useAdminWrite<T>(toRequest: (input: T) => { url: string; init: RequestInit }) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: T) => {
			const { url, init } = toRequest(input);
			return request(z.unknown(), url, init);
		},
		onSettled: () => {
			void client.invalidateQueries({ queryKey: ["admin"] });
		},
	});
}

/** Start, stop and restart use the student routes, which accept an administrator. */
export function useLifecycleAction() {
	return useAdminWrite(
		({
			workspaceId,
			action,
		}: {
			workspaceId: string;
			action: "start" | "stop" | "restart";
		}) => ({
			url: `/workspaces/${workspaceId}/${action}`,
			init: { method: "POST" },
		}),
	);
}

/** The single-row admin route for one account or workspace action. */
export function adminActionUrl(
	resource: "users" | "workspaces",
	id: string,
	action: "disable" | "enable" | "archive" | "unarchive",
): string {
	return `/admin/${resource}/${id}/${action}`;
}

export function useSetDisabled() {
	return useAdminWrite(
		({ userId, disabled }: { userId: string; disabled: boolean }) => ({
			url: adminActionUrl("users", userId, disabled ? "disable" : "enable"),
			init: { method: "POST" },
		}),
	);
}

export function useSetArchived() {
	return useAdminWrite(
		({ workspaceId, archived }: { workspaceId: string; archived: boolean }) => ({
			url: adminActionUrl(
				"workspaces",
				workspaceId,
				archived ? "archive" : "unarchive",
			),
			init: { method: "POST" },
		}),
	);
}

/** Promote grants administrator; demote clears the grant (ADR 0026). */
export function useSetGrantedAdmin() {
	return useAdminWrite(({ userId, admin }: { userId: string; admin: boolean }) => ({
		url: `/admin/users/${userId}/${admin ? "promote" : "demote"}`,
		init: { method: "POST" },
	}));
}

/** Make instructor sets the grant; remove instructor clears it (ADR 0026). */
export function useSetGrantedInstructor() {
	return useAdminWrite(
		({ userId, instructor }: { userId: string; instructor: boolean }) => ({
			url: `/admin/users/${userId}/${instructor ? "make-instructor" : "remove-instructor"}`,
			init: { method: "POST" },
		}),
	);
}

/**
 * The Dex user writes (ADR 0028). Each waits for the
 * list to refetch before its caller hears of success, so the caller can move
 * focus knowing which buttons are still on the page.
 */
function useDexWrite<T, R>(run: (input: T) => Promise<R>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: run,
		onSuccess: () => client.invalidateQueries({ queryKey: ["admin"] }),
	});
}

export function useAddDexUser() {
	return useDexWrite((body: CreateDexUserRequest) =>
		request(CreateDexUserResponse, "/admin/dex-users", json("POST", body)),
	);
}

export function useResetDexPassword() {
	return useDexWrite(({ userId }: { userId: string }) =>
		request(DexPasswordResponse, `/admin/dex-users/${userId}/reset-password`, {
			method: "POST",
		}),
	);
}

export function useRemoveDexUser() {
	return useDexWrite(({ userId }: { userId: string }) =>
		request(AdminUser, `/admin/dex-users/${userId}/remove`, { method: "POST" }),
	);
}

export function useUpdateQuota() {
	return useAdminWrite(
		({ workspaceId, quota }: { workspaceId: string; quota: QuotaConfig }) => ({
			url: `/admin/workspaces/${workspaceId}/quota`,
			init: json("PUT", quota),
		}),
	);
}

/** The rebuild and reset operations; the buttons follow `capabilities`. */
export function useRebuild() {
	return useAdminWrite(
		({ workspaceId, resetDocker }: { workspaceId: string; resetDocker: boolean }) => ({
			url: `/admin/workspaces/${workspaceId}/rebuild`,
			init: json("POST", { resetDocker }),
		}),
	);
}

/** Per-workspace resource guard overrides; null removes one (ADR 0032). */
export function useUpdateGuard() {
	return useAdminWrite(
		({ workspaceId, body }: { workspaceId: string; body: UpdateGuardRequest }) => ({
			url: `/admin/workspaces/${workspaceId}/guard`,
			init: json("PUT", body),
		}),
	);
}

/** Lift a CPU throttle or clear a memory flag (ADR 0032). */
export function useGuardClear() {
	return useAdminWrite(
		({
			workspaceId,
			action,
		}: {
			workspaceId: string;
			action: "lift-throttle" | "clear-memory-flag";
		}) => ({
			url: `/admin/workspaces/${workspaceId}/${action}`,
			init: { method: "POST" },
		}),
	);
}

/** One workspace's CPU, memory and process limits; null uses the profile (SPEC.md section 20.1). */
export function useUpdateLimits() {
	return useAdminWrite(
		({ workspaceId, body }: { workspaceId: string; body: UpdateLimitsRequest }) => ({
			url: `/admin/workspaces/${workspaceId}/limits`,
			init: json("PUT", body),
		}),
	);
}

/** Send a workspace in error back to provisioning (SPEC.md section 20.1). */
export function useReprovision() {
	return useAdminWrite(({ workspaceId }: { workspaceId: string }) => ({
		url: `/admin/workspaces/${workspaceId}/reprovision`,
		init: { method: "POST" },
	}));
}

export function useResetDocker() {
	return useAdminWrite(({ workspaceId }: { workspaceId: string }) => ({
		url: `/workspaces/${workspaceId}/reset-docker`,
		init: { method: "POST" },
	}));
}
