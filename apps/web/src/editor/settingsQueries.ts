import { EditorSettings, type UpdateEditorSettingsRequest } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/request.js";

export const editorSettingsKey = ["me", "settings"] as const;

/** The signed-in user's editor settings, defaults filled in (issue #159). */
export function useEditorSettings() {
	return useQuery({
		queryKey: editorSettingsKey,
		queryFn: () => request(EditorSettings, "/me/settings"),
	});
}

/** Change some of them; the server merges and returns the whole set. */
export function useUpdateEditorSettings() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: UpdateEditorSettingsRequest) =>
			request(EditorSettings, "/me/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: (settings) => {
			client.setQueryData(editorSettingsKey, settings);
		},
	});
}
