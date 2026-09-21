import {
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	type UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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

/**
 * Keeps `data-terminal-theme` on <html> in step with the student's choice
 * (issue #239). theme.css does the rest, both for the terminal itself and for
 * the chrome around it that uses the `--terminal-*` tokens.
 */
export function useTerminalThemeAttribute(): void {
	const settings = useEditorSettings();
	const theme = settings.data?.terminalTheme ?? EDITOR_SETTINGS_DEFAULTS.terminalTheme;
	useEffect(() => {
		document.documentElement.setAttribute("data-terminal-theme", theme);
	}, [theme]);
}
