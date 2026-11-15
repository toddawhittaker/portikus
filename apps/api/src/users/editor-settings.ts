import {
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	isSystemTimezone,
	MAX_PANE_ZOOMS,
	type PaneZoomChanges,
	PaneZoomKey,
	PaneZoomPercent,
	type PaneZooms,
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

/** One stored pane zoom: the percentage and when it was last set, in ms. */
type StoredPaneZoom = [number, number];

/** The stored pane zooms, keeping only well-formed entries. */
function storedPaneZooms(stored: unknown): Record<string, StoredPaneZoom> {
	const raw = (stored as { paneZooms?: unknown } | null | undefined)?.paneZooms;
	const out: Record<string, StoredPaneZoom> = {};
	if (typeof raw !== "object" || raw === null) return out;
	for (const [key, entry] of Object.entries(raw)) {
		if (!Array.isArray(entry) || !PaneZoomKey.safeParse(key).success) continue;
		const [zoom, at] = entry as unknown[];
		if (PaneZoomPercent.safeParse(zoom).success && typeof at === "number") {
			out[key] = [zoom as number, at];
		}
	}
	return out;
}

/** Each pane's zoom as `GET /me/settings` returns it (SPEC.md §7.5). */
export function toPaneZooms(stored: unknown): PaneZooms {
	const out: PaneZooms = {};
	for (const [key, [zoom]] of Object.entries(storedPaneZooms(stored))) out[key] = zoom;
	return out;
}

/**
 * The stored pane zooms with `changes` applied: a percentage sets a pane's
 * zoom and marks it newest, null forgets it. Past MAX_PANE_ZOOMS the least
 * recently set go, so one user's map stays small.
 */
export function mergePaneZooms(
	stored: unknown,
	changes: PaneZoomChanges,
	now: number,
): Record<string, StoredPaneZoom> {
	const merged = storedPaneZooms(stored);
	for (const [key, zoom] of Object.entries(changes)) {
		if (zoom === null) delete merged[key];
		else merged[key] = [zoom, now];
	}
	const entries = Object.entries(merged);
	if (entries.length <= MAX_PANE_ZOOMS) return merged;
	entries.sort((a, b) => b[1][1] - a[1][1]);
	return Object.fromEntries(entries.slice(0, MAX_PANE_ZOOMS));
}
