import {
	MAX_PROFILE_PICTURE_BYTES,
	MyLinks,
	PICTURE_TOO_LARGE_MESSAGE,
	Profile,
	StartLinkResponse,
	UnlinkResponse,
	type UpdateProfileRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/request.js";

export const profileKey = ["me", "profile"] as const;

/** The signed-in user's profile (issue #300). */
export function useProfile() {
	return useQuery({
		queryKey: profileKey,
		queryFn: () => request(Profile, "/me/profile"),
	});
}

/** Every profile change answers with the whole profile, which replaces the cache. */
function useProfileMutation<T>(send: (input: T) => Promise<Profile>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: send,
		onSuccess: (profile) => client.setQueryData(profileKey, profile),
	});
}

export function useUpdateProfile() {
	return useProfileMutation((body: UpdateProfileRequest) =>
		request(Profile, "/me/profile", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

/**
 * The server checks the size and reads the type from the bytes. The size is
 * checked here too, because the server stops reading an oversized body and a
 * proxy in between can turn its answer into a generic failure.
 */
export function useUploadPicture() {
	return useProfileMutation(async (file: File) => {
		if (file.size > MAX_PROFILE_PICTURE_BYTES) {
			throw new Error(PICTURE_TOO_LARGE_MESSAGE);
		}
		return await request(Profile, "/me/picture", {
			method: "PUT",
			headers: { "content-type": file.type || "application/octet-stream" },
			body: file,
		});
	});
}

export function useRemovePicture() {
	return useProfileMutation(() =>
		request(Profile, "/me/picture", { method: "DELETE" }),
	);
}

export const linksKey = ["me", "links"] as const;

/** Whether this is a course or an SSO account, and its links (docs/EPIC-13-1.md, "The flow" step 1). */
export function useMyLinks() {
	return useQuery({
		queryKey: linksKey,
		queryFn: () => request(MyLinks, "/me/links"),
	});
}

/** Step 2: the server answers with the SSO sign-in address. */
export function startLink() {
	return request(StartLinkResponse, "/me/links/start", { method: "POST" });
}

/** Step 7. */
export function useUnlink() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (courseUserId: string) =>
			request(UnlinkResponse, `/me/links/${encodeURIComponent(courseUserId)}/unlink`, {
				method: "POST",
			}),
		// Returning the refetch makes a caller's onSuccess wait until the row is gone.
		onSuccess: ({ signedOut }) =>
			// This session is gone, so a full load drops every cached answer.
			signedOut
				? location.assign("/unlinked")
				: client.invalidateQueries({ queryKey: linksKey }),
	});
}
