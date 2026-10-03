/**
 * The file tree's keyboard, after the WAI-ARIA tree view pattern with its
 * multi-select model (SPEC.md §11.2, §25.8). Moving the focus selects the
 * row it lands on, as a plain click does; Shift extends the selection from
 * the anchor, as Shift-click does; Ctrl moves without selecting, and
 * Ctrl+Space adds or removes the focused row, as Ctrl-click does.
 */
import type { KeyboardEvent } from "react";
import { useRef } from "react";
import { baseName, displayName, parentOf } from "./paths.js";
import {
	type ClickModifiers,
	type FileNode,
	type Selection,
	selectionAfterClick,
} from "./selection.js";

/** How long a pause starts the typed text again. */
export const TYPE_AHEAD_RESET_MS = 500;

export interface TypeAhead {
	text: string;
	/** When the last letter was typed, in milliseconds. */
	at: number;
}

/** The typed text after one more letter at time `now`. */
export function nextTypeAhead(
	previous: TypeAhead,
	key: string,
	now: number,
): TypeAhead {
	const fresh = now - previous.at > TYPE_AHEAD_RESET_MS;
	return { text: fresh ? key : previous.text + key, at: now };
}

/**
 * The index of the row whose name starts with `typed`, searching from the
 * focused row `current` and wrapping round, or -1. A single letter, or one
 * letter pressed again and again, looks past the focused row, so it cycles
 * through the rows with that initial.
 */
export function typeAheadIndex(
	names: readonly string[],
	current: number,
	typed: string,
): number {
	const letters = Array.from(typed.toLocaleLowerCase());
	const cycling = letters.every((letter) => letter === letters[0]);
	const prefix = cycling ? (letters[0] ?? "") : letters.join("");
	if (prefix === "" || names.length === 0) return -1;
	const start = cycling ? current + 1 : current;
	for (let step = 0; step < names.length; step++) {
		const index = (start + step) % names.length;
		if (names[index]?.toLocaleLowerCase().startsWith(prefix)) return index;
	}
	return -1;
}

/**
 * The selection after Shift moves the focus from `from` to `to`: the run
 * from the anchor, which is the row left behind when nothing anchors yet.
 */
export function selectionAfterExtend(
	current: Selection,
	from: string,
	to: string,
	order: readonly string[],
): Selection {
	const anchored = { ...current, anchor: current.anchor ?? from };
	return selectionAfterClick(anchored, to, { toggle: false, range: true }, order);
}

/** What the tree's keys need from the pane. */
export interface TreeKeysApi {
	expanded: readonly string[];
	toggle: (path: string) => void;
	setOpen: (path: string, open: boolean) => void;
	openFile: (node: FileNode) => void;
	remove: (node: FileNode) => void;
	setFocusedPath: (path: string | null) => void;
	setMenuPath: (path: string | null) => void;
	rowElements: () => HTMLElement[];
	clickRow: (path: string, modifiers: ClickModifiers) => void;
	extendTo: (from: string, to: string) => void;
}

/** How a move treats the selection. */
type Move = "select" | "extend" | "focus";

const pathOf = (row: HTMLElement): string => row.getAttribute("data-path") ?? "";

/** The focused row a key was pressed on, and what can be done from it. */
interface KeyContext {
	api: TreeKeysApi;
	node: FileNode;
	open: boolean;
	rows: HTMLElement[];
	index: number;
	moveTo: (row: HTMLElement | undefined, how: Move) => void;
}

/** Moves the focus for a navigation key; false when the key is not one. */
function navigate(context: KeyContext, key: string, how: Move): boolean {
	const { api, node, open, rows, index, moveTo } = context;
	switch (key) {
		case "ArrowDown":
			moveTo(rows[index + 1], how);
			return true;
		case "ArrowUp":
			moveTo(rows[index - 1], how);
			return true;
		case "Home":
			moveTo(rows[0], how);
			return true;
		case "End":
			moveTo(rows[rows.length - 1], how);
			return true;
		case "ArrowRight":
			if (node.isDir && !open) api.setOpen(node.path, true);
			else if (node.isDir) moveTo(rows[index + 1], "select");
			return true;
		case "ArrowLeft": {
			if (node.isDir && open) {
				api.setOpen(node.path, false);
				return true;
			}
			const parent = parentOf(node.path);
			moveTo(
				rows.find((row) => pathOf(row) === parent),
				"select",
			);
			return true;
		}
		default:
			return false;
	}
}

/** Open, select, menu and delete keys; false when the key is not one. */
function command(context: KeyContext, event: KeyboardEvent<HTMLElement>): boolean {
	const { api, node } = context;
	const activate = () => {
		if (node.isDir) api.toggle(node.path);
		else api.openFile(node);
	};
	switch (event.key) {
		case " ":
			if (event.ctrlKey || event.metaKey) {
				api.clickRow(node.path, { toggle: true, range: false });
			} else activate();
			return true;
		case "Enter":
			activate();
			return true;
		case "F10":
			if (!event.shiftKey) return false;
			api.setMenuPath(node.path);
			return true;
		case "ContextMenu":
			api.setMenuPath(node.path);
			return true;
		case "Delete":
			// Delete acts on the selection when the focused row is part of it.
			api.remove(node);
			return true;
		default:
			return false;
	}
}

/** The tree's keydown handler. */
export function useTreeKeys(
	api: TreeKeysApi,
): (event: KeyboardEvent<HTMLElement>) => void {
	const typed = useRef<TypeAhead>({ text: "", at: 0 });

	return (event) => {
		const target = event.target;
		// A key pressed on the row's own button or link belongs to that control.
		if (!(target instanceof Element) || target.closest("button, a, input")) return;
		const current = target.closest<HTMLElement>("[role=treeitem]");
		if (!current) return;
		const path = pathOf(current);
		const rows = api.rowElements();
		const context: KeyContext = {
			api,
			node: {
				path,
				name: baseName(path),
				isDir: current.getAttribute("data-kind") === "dir",
			},
			open: api.expanded.includes(path),
			rows,
			index: rows.indexOf(current),
			moveTo: (row, how) => {
				if (!row) return;
				const to = pathOf(row);
				if (how === "select") api.clickRow(to, { toggle: false, range: false });
				if (how === "extend") api.extendTo(path, to);
				api.setFocusedPath(to);
				row.focus();
			},
		};
		const ctrl = event.ctrlKey || event.metaKey;
		const how: Move = event.shiftKey ? "extend" : ctrl ? "focus" : "select";
		if (navigate(context, event.key, how) || command(context, event)) {
			event.preventDefault();
			return;
		}

		// Type-ahead: a printable letter jumps to the next row starting with it.
		if (event.key.length !== 1 || ctrl || event.altKey) return;
		typed.current = nextTypeAhead(typed.current, event.key, event.timeStamp);
		const names = rows.map((row) => displayName(baseName(pathOf(row))));
		const found = typeAheadIndex(names, context.index, typed.current.text);
		if (found === -1) return;
		event.preventDefault();
		context.moveTo(rows[found], "select");
	};
}
