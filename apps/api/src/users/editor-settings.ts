import {
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	isSystemTimezone,
} from "@portikus/contracts";

/**
 * Fill in the defaults for anything the user has not set, and ignore anything
 * stored that is no longer a setting we know.
 *
 * Each field is parsed on its own, so one bad stored value (for example a
 * zone name this build no longer knows) falls back to its own
 * default and takes none of the student's other settings with it.
 */
export function toEditorSettings(stored: unknown): EditorSettings {
	const raw = (stored ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = { ...EDITOR_SETTINGS_DEFAULTS };
	for (const [key, schema] of Object.entries(EditorSettings.shape)) {
		const parsed = schema.safeParse(raw[key]);
		if (parsed.success) out[key] = parsed.data;
	}
	if (!isSystemTimezone(out.timezone)) out.timezone = EDITOR_SETTINGS_DEFAULTS.timezone;
	return out as EditorSettings;
}
