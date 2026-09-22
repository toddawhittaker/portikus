import {
	EDITOR_SETTINGS_DEFAULTS,
	MeSettings,
	type UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { request } from "../api/request.js";
import { rememberThemePreference } from "../shell/theme.js";

export const editorSettingsKey = ["me", "settings"] as const;

/**
 * The signed-in user's editor settings, defaults filled in (issue #159), with
 * the zone names the server accepts alongside them (issue #287).
 */
export function useEditorSettings() {
	return useQuery({
		queryKey: editorSettingsKey,
		// The saved appearance wins over this browser's copy, and it is applied
		// here, before anything renders with the settings (issue #300).
		queryFn: async () => {
			const settings = await request(MeSettings, "/me/settings");
			rememberThemePreference(settings.appearance);
			return settings;
		},
	});
}

/** Change some of them; the server merges and returns the whole set. */
export function useUpdateEditorSettings() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: UpdateEditorSettingsRequest) =>
			request(MeSettings, "/me/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: (settings) => {
			rememberThemePreference(settings.appearance);
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

/**
 * Whether terminals run in xterm's screen-reader mode (issue #357). Off until
 * the settings arrive, since the mode has a rendering cost.
 */
export function useScreenReaderMode(): boolean {
	const settings = useEditorSettings();
	return settings.data?.screenReaderMode ?? EDITOR_SETTINGS_DEFAULTS.screenReaderMode;
}
