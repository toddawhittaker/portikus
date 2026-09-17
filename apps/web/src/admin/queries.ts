import {
	AdminUser,
	AdminUserList,
	PlatformSettings,
	type UpdateAdminUserSettingsRequest,
	type UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/request.js";

export const adminKeys = {
	settings: ["admin", "settings"] as const,
	users: ["admin", "users"] as const,
};

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

export function useAdminUsers() {
	return useQuery({
		queryKey: adminKeys.users,
		queryFn: async () => (await request(AdminUserList, "/admin/users")).users,
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
