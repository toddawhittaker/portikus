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
	type UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

export const adminKeys = {
	settings: ["admin", "settings"] as const,
	users: ["admin", "users"] as const,
	workspace: (id: string) => ["admin", "workspace", id] as const,
};

/** The list and the detail panel refresh this often (Epic 11 brief, "Decisions"). */
export const ADMIN_REFRESH_MS = 5000;

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

/** Every account, and whether the site manages Dex users (docs/archive/epics/EPIC-14.md ruling 24). */
export function useAdminUsers() {
	return useQuery({
		queryKey: adminKeys.users,
		queryFn: () => request(AdminUserList, "/admin/users"),
		refetchInterval: ADMIN_REFRESH_MS,
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

/** Promote grants administrator; demote clears the grant (docs/archive/epics/EPIC-13-1.md ruling 23). */
export function useSetGrantedAdmin() {
	return useAdminWrite(({ userId, admin }: { userId: string; admin: boolean }) => ({
		url: `/admin/users/${userId}/${admin ? "promote" : "demote"}`,
		init: { method: "POST" },
	}));
}

/** Make instructor sets the grant; remove instructor clears it (docs/archive/epics/EPIC-14.md ruling 14). */
export function useSetGrantedInstructor() {
	return useAdminWrite(
		({ userId, instructor }: { userId: string; instructor: boolean }) => ({
			url: `/admin/users/${userId}/${instructor ? "make-instructor" : "remove-instructor"}`,
			init: { method: "POST" },
		}),
	);
}

/**
 * The Dex user writes (docs/archive/epics/EPIC-14.md rulings 21 and 22). Each waits for the
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

/** Epic 10's routes; the buttons follow `capabilities` (Epic 11 brief, ruling 1). */
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

export function useResetDocker() {
	return useAdminWrite(({ workspaceId }: { workspaceId: string }) => ({
		url: `/workspaces/${workspaceId}/reset-docker`,
		init: { method: "POST" },
	}));
}
