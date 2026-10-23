import {
	type AdminBackups,
	type BackupRequestKind,
	type BackupRequestView,
	keptSetStamps,
} from "@portikus/contracts";
import { joinWords, plural } from "../../text.js";
import { setTime, waitingRequest, workspaceName } from "./model.js";

/** One item a Delete button or a ticked row asks to delete. */
export type DeleteTarget =
	| { kind: "set"; stamp: string }
	| { kind: "dump"; file: string }
	| { kind: "snapshot"; volume: string; snapshot: string }
	| { kind: "kept"; volume: string; name: string };

export type DeleteKind = DeleteTarget["kind"];

/** The lists in page order, so a confirm names the kinds as the page shows them. */
const KINDS: readonly DeleteKind[] = ["set", "snapshot", "kept", "dump"];

const NOUN: Record<DeleteKind, [one: string, many: string]> = {
	set: ["backup set", "backup sets"],
	snapshot: ["snapshot", "snapshots"],
	kept: ["kept home", "kept homes"],
	dump: ["database dump", "database dumps"],
};

export const NEWEST_KEPT = "The newest complete set is always kept";
const ALREADY_WAITING = "A delete is already waiting";

function keptNightlyText(count: number): string {
	return count === 1
		? "Kept by the server: the newest nightly set"
		: `Kept by the server: the newest ${count} nightly sets`;
}

/**
 * Why the host would refuse to delete each set, by stamp. The floor is
 * advisory; the host enforces it (ADR 0039). An older host reports none, so
 * only the newest complete set is marked.
 */
export function floorReasons(host: AdminBackups["host"]): Map<string, string> {
	if (!host) return new Map();
	const floor = host.floor;
	const nightly = floor
		? keptNightlyText(Math.max(floor.keepComplete, 1))
		: NEWEST_KEPT;
	// A requested set is kept only when no nightly set is complete.
	const requested = new Set(
		host.sets.filter((set) => set.requested).map((set) => set.stamp),
	);
	return new Map(
		keptSetStamps(host).map((stamp) => [
			stamp,
			requested.has(stamp) ? NEWEST_KEPT : nightly,
		]),
	);
}

/** Unique within the tab; Incus volume and snapshot names and dump files hold no slash. */
export function targetKey(target: DeleteTarget): string {
	switch (target.kind) {
		case "set":
			return `set:${target.stamp}`;
		case "dump":
			return `dump:${target.file}`;
		case "snapshot":
			return `snapshot:${target.volume}/${target.snapshot}`;
		case "kept":
			return `kept:${target.volume}`;
	}
}

/** The item as a failure message names it. */
export function targetName(target: DeleteTarget): string {
	switch (target.kind) {
		case "set":
			return `The backup set from ${setTime(target.stamp)}`;
		case "dump":
			return target.file;
		case "snapshot":
			return `Snapshot ${target.snapshot} of ${target.volume}`;
		case "kept":
			return `The kept home of ${target.name}`;
	}
}

function requestFor(target: DeleteTarget): [BackupRequestKind, Record<string, string>] {
	switch (target.kind) {
		case "set":
			return ["delete_set", { stamp: target.stamp }];
		case "dump":
			return ["delete_dump", { file: target.file }];
		case "snapshot":
			return ["delete_snapshot", { volume: target.volume, snapshot: target.snapshot }];
		case "kept":
			return ["delete_kept_home", { volume: target.volume }];
	}
}

/** Whether a delete of this item is already waiting or running. */
export function deleteWaiting(
	requests: BackupRequestView[],
	target: DeleteTarget,
): boolean {
	const [kind, args] = requestFor(target);
	return waitingRequest(requests, kind, args) !== undefined;
}

/** A row that can be ticked, or says why it cannot. */
export interface Pickable {
	key: string;
	target: DeleteTarget;
	blocked: string | null;
}

/** Every listed item on the tab, in page order. */
export function pickables(data: AdminBackups): Pickable[] {
	const { host, vm, requests, workspaces } = data;
	const kept = floorReasons(host);
	const targets: DeleteTarget[] = [
		...(host?.sets ?? []).map(
			(set): DeleteTarget => ({ kind: "set", stamp: set.stamp }),
		),
		...(vm?.snapshots ?? []).map(
			(snap): DeleteTarget => ({
				kind: "snapshot",
				volume: snap.volume,
				snapshot: snap.name,
			}),
		),
		...(vm?.keptHomes ?? []).map(
			(kept): DeleteTarget => ({
				kind: "kept",
				volume: kept.volume,
				name: workspaceName(kept.instance, workspaces),
			}),
		),
		...(host?.dumps ?? []).map(
			(dump): DeleteTarget => ({ kind: "dump", file: dump.file }),
		),
	];
	return targets.map((target) => ({
		key: targetKey(target),
		target,
		blocked:
			(target.kind === "set" ? kept.get(target.stamp) : undefined) ??
			(deleteWaiting(requests, target) ? ALREADY_WAITING : null),
	}));
}

/** The ticked items still listed and still deletable, in page order. */
export function pickedItems(
	items: Pickable[],
	selected: ReadonlySet<string>,
): Pickable[] {
	return items.filter((item) => item.blocked === null && selected.has(item.key));
}

/** `selected` with `keys` ticked or unticked. */
export function withKeys(
	selected: ReadonlySet<string>,
	keys: readonly string[],
	on: boolean,
): ReadonlySet<string> {
	const next = new Set(selected);
	for (const key of keys) {
		if (on) next.add(key);
		else next.delete(key);
	}
	return next;
}

/** The "select all" box of one list: ticked, dashed, or off when nothing can be ticked. */
export function allBoxState(
	items: Pickable[],
	selected: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean; unavailable: boolean } {
	const open = items.filter((item) => item.blocked === null);
	const ticked = open.filter((item) => selected.has(item.key)).length;
	return {
		checked: open.length > 0 && ticked === open.length,
		indeterminate: ticked > 0 && ticked < open.length,
		unavailable: open.length === 0,
	};
}

/**
 * The Delete selected button's words. Ticks span the whole tab, so when some
 * are in another list the label says so rather than implying this list's rows.
 */
export function deleteSelectedText(total: number, here: number): string {
	return total > here
		? `Delete ${total} selected on this tab…`
		: `Delete ${total} selected…`;
}

/** "2 backup sets and 1 database dump", kinds in page order. */
export function kindsText(targets: readonly DeleteTarget[]): string {
	return joinWords(
		KINDS.flatMap((kind) => {
			const count = targets.filter((target) => target.kind === kind).length;
			return count > 0 ? [plural(count, NOUN[kind][0], NOUN[kind][1])] : [];
		}),
	);
}

function singleCopy(target: DeleteTarget): { title: string; description: string[] } {
	switch (target.kind) {
		case "set":
			return {
				title: `Delete the backup set from ${setTime(target.stamp)}?`,
				description: [
					"The host removes this set. Workspaces can no longer be restored from it.",
				],
			};
		case "dump":
			return {
				title: `Delete ${target.file}?`,
				description: ["The host removes this pre-change database dump."],
			};
		case "snapshot":
			return {
				title: `Delete snapshot ${target.snapshot}?`,
				description: [
					`The snapshot is removed from ${target.volume}. The volume itself does not change.`,
				],
			};
		case "kept":
			return {
				title: `Delete the kept home of ${target.name}?`,
				description: [
					"This is the home folder a replace took out of service. Once deleted it cannot be put back.",
				],
			};
	}
}

const MANY_CONSEQUENCE: Record<DeleteKind, string> = {
	set: "Workspaces can no longer be restored from the deleted sets.",
	snapshot: "Deleting a snapshot leaves its volume unchanged.",
	kept: "Deleted kept homes cannot be put back.",
	dump: "The host removes the database dumps.",
};

/**
 * The confirm's words: one item by name, several by count and kind only, so
 * a long selection never turns into a long list.
 */
export function deleteCopy(targets: readonly DeleteTarget[]): {
	title: string;
	description: string[];
} {
	const [first] = targets;
	if (targets.length === 1 && first) return singleCopy(first);
	const kinds = KINDS.filter((kind) => targets.some((target) => target.kind === kind));
	const mixed = kinds.length > 1;
	return {
		title: mixed ? `Delete ${targets.length} items?` : `Delete ${kindsText(targets)}?`,
		description: [
			...(mixed ? [`${kindsText(targets)}.`] : []),
			...kinds.map((kind) => MANY_CONSEQUENCE[kind]),
		],
	};
}
