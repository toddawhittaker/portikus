/**
 * The zoom of each pane in the student's workspace (SPEC.md §7.5, §13.1). It
 * is kept with their settings on the server, so a restarted workspace, a
 * reload, or another browser shows each pane at the zoom it was left at.
 *
 * A terminal or chat is keyed by its project and terminal id, a file by its
 * project and path, which its editor and diff share. What this tab sets wins
 * over what the server last said, and a failed save keeps it here anyway.
 * The keys hold file paths, which are student data, so they are never logged.
 */
import { MeSettings, type PaneZoomChanges, type PaneZooms } from "@portikus/contracts";
import { sendJson } from "../api/request.js";
import { clampZoom } from "../editor/zoom.js";
import { movedPath } from "../files/paths.js";

/** How long a run of zoom steps waits before one save covers them all. */
export const SAVE_DELAY_MS = 500;

export function terminalZoomKey(projectId: string, terminalId: string): string {
	return `${projectId}:t:${terminalId}`;
}

export function fileZoomKey(projectId: string, path: string): string {
	return `${projectId}:f:${path}`;
}

// These outlive a client-side page change, so a different signed-in user
// clears them first (paneZoomsFor). Sign-in and sign-out are full loads.
/** Whose zooms these are, once the session is known. */
let owner: string | null = null;
/** What the server sent with the settings, or null before they arrive. */
let fromServer: PaneZooms | null = null;
/** What this tab has set since; null forgets a pane. */
let local: Record<string, number | null> = {};
let pending: PaneZoomChanges = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify() {
	for (const listener of listeners) listener();
}

export function subscribePaneZooms(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Take the server's zooms once; later answers never undo what this tab set.
 * Panes already on screen take them up.
 */
export function seedPaneZooms(zooms: PaneZooms | undefined): void {
	if (fromServer !== null) return;
	fromServer = zooms ?? {};
	notify();
}

/**
 * The signed-in user is `userId`. Another user's zooms, and any save of
 * theirs still waiting, are dropped, so they are never shown or saved here.
 */
export function paneZoomsFor(userId: string): void {
	if (owner !== null && owner !== userId) resetPaneZooms();
	owner = userId;
}

export function readPaneZoom(key: string): number | undefined {
	const mine = local[key];
	if (mine === null) return undefined;
	const value = mine ?? fromServer?.[key];
	return value === undefined ? undefined : clampZoom(value);
}

/** The waiting changes, now taken; null when there are none. */
function takePending(): PaneZoomChanges | null {
	if (timer !== null) clearTimeout(timer);
	timer = null;
	const changes = pending;
	pending = {};
	return Object.keys(changes).length === 0 ? null : changes;
}

function flush() {
	const changes = takePending();
	if (changes === null) return;
	// A failed save loses nothing here: the zoom stays in `local`.
	sendJson(MeSettings, "/me/settings", { paneZooms: changes }, "PUT").catch(() => {});
}

/**
 * The tab is closing: send a save still waiting now, with keepalive so the
 * browser finishes it after the page is gone.
 */
function flushPaneZoomsOnHide(): void {
	const changes = takePending();
	if (changes === null) return;
	void fetch("/me/settings", {
		method: "PUT",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ paneZooms: changes }),
		keepalive: true,
	}).catch(() => {});
}

if (typeof window !== "undefined")
	window.addEventListener("pagehide", flushPaneZoomsOnHide);

function change(key: string, percent: number | null) {
	local = { ...local, [key]: percent };
	pending[key] = percent;
	if (timer === null) timer = setTimeout(flush, SAVE_DELAY_MS);
	notify();
}

export function writePaneZoom(key: string, percent: number): void {
	change(key, clampZoom(percent));
}

/** Every key with a zoom, from the server or this tab. */
function knownKeys(): string[] {
	const keys = new Set([...Object.keys(fromServer ?? {}), ...Object.keys(local)]);
	return [...keys].filter((key) => readPaneZoom(key) !== undefined);
}

/**
 * Forget the zoom of every pane in `projectId` that `live` (its pane keys)
 * no longer has. Nothing is forgotten before the server's zooms are in, so
 * a partial load never drops a pane.
 */
export function prunePaneZooms(projectId: string, live: ReadonlySet<string>): void {
	if (fromServer === null) return;
	const prefix = `${projectId}:`;
	for (const key of knownKeys()) {
		if (key.startsWith(prefix) && !live.has(key)) change(key, null);
	}
}

/** Files were closed: their zooms go with their panes. */
export function forgetFileZooms(projectId: string, paths: string[]): void {
	for (const path of paths) {
		const key = fileZoomKey(projectId, path);
		if (readPaneZoom(key) !== undefined) change(key, null);
	}
}

/** A file or folder moved: its files' zooms move with them. */
export function movePaneZooms(projectId: string, from: string, to: string): void {
	const prefix = fileZoomKey(projectId, "");
	for (const key of knownKeys()) {
		if (!key.startsWith(prefix)) continue;
		const now = movedPath(key.slice(prefix.length), from, to);
		const zoom = readPaneZoom(key);
		if (now === null || zoom === undefined) continue;
		change(key, null);
		change(fileZoomKey(projectId, now), zoom);
	}
}

/** Forget everything, including a save still waiting. */
export function resetPaneZooms(): void {
	if (timer !== null) clearTimeout(timer);
	timer = null;
	owner = null;
	fromServer = null;
	local = {};
	pending = {};
	notify();
}

/** For tests: send the waiting save now. */
export function flushPaneZooms(): void {
	flush();
}
