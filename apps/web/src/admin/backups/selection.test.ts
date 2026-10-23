import type { AdminBackups, HostBackupSet } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	allBoxState,
	type DeleteTarget,
	deleteCopy,
	deleteSelectedText,
	floorReasons,
	kindsText,
	NEWEST_KEPT,
	pickables,
	pickedItems,
	targetKey,
	targetName,
	withKeys,
} from "./selection.js";
import { ALICE_INSTANCE, backups, FAILED, NEW, OLD, view } from "./testBackups.js";

const SET: DeleteTarget = { kind: "set", stamp: OLD };
const DUMP: DeleteTarget = { kind: "dump", file: "a.dump" };
const SNAP: DeleteTarget = { kind: "snapshot", volume: "v-home", snapshot: "pre-x" };
const KEPT: DeleteTarget = { kind: "kept", volume: "v-home-replaced-1", name: "Alice" };

test("every item has its own key, and the same item always the same one", () => {
	const keys = [SET, DUMP, SNAP, KEPT].map(targetKey);
	expect(new Set(keys).size).toBe(4);
	expect(targetKey({ kind: "set", stamp: OLD })).toBe(targetKey(SET));
	// A dump and a set never share a key, even with the same text.
	expect(targetKey({ kind: "dump", file: OLD })).not.toBe(targetKey(SET));
});

test("the tab's items run in page order, and the newest complete set says why it cannot be ticked", () => {
	const items = pickables(backups());
	expect(items.map((item) => item.target.kind)).toEqual([
		"set",
		"set",
		"set",
		"snapshot",
		"kept",
		"dump",
	]);
	const blocked = Object.fromEntries(items.map((item) => [item.key, item.blocked]));
	expect(blocked[targetKey({ kind: "set", stamp: NEW })]).toBe(NEWEST_KEPT);
	expect(blocked[targetKey({ kind: "set", stamp: FAILED })]).toBeNull();
	expect(blocked[targetKey({ kind: "set", stamp: OLD })]).toBeNull();
	// The kept home is named after its workspace, as its row is.
	expect(items[4]?.target).toMatchObject({ kind: "kept", name: "Alice Smith (alice)" });
});

test("an item whose delete is already waiting cannot be ticked again", () => {
	const items = pickables(
		backups({
			requests: [
				view({
					kind: "delete_snapshot",
					args: { volume: `${ALICE_INSTANCE}-home`, snapshot: "pre-upgrade" },
					state: "claimed",
				}),
				// A finished delete no longer blocks.
				view({ kind: "delete_dump", args: { file: "portikus-pre-upgrade.dump" } }),
			],
		}),
	);
	const snapshot = items.find((item) => item.target.kind === "snapshot");
	const dump = items.find((item) => item.target.kind === "dump");
	expect(snapshot?.blocked).toBe("A delete is already waiting");
	expect(dump?.blocked).toBeNull();
});

test("only ticked items still listed and deletable are picked", () => {
	const items = pickables(backups());
	const selected = new Set([
		targetKey({ kind: "set", stamp: OLD }),
		targetKey({ kind: "set", stamp: NEW }),
		targetKey({ kind: "dump", file: "gone.dump" }),
		targetKey({ kind: "dump", file: "portikus-pre-upgrade.dump" }),
	]);
	expect(pickedItems(items, selected).map((item) => item.target)).toEqual([
		{ kind: "set", stamp: OLD },
		{ kind: "dump", file: "portikus-pre-upgrade.dump" },
	]);
});

test("ticking and unticking keys leaves the rest alone", () => {
	const start = new Set(["a", "b"]);
	expect([...withKeys(start, ["c"], true)]).toEqual(["a", "b", "c"]);
	expect([...withKeys(start, ["a", "z"], false)]).toEqual(["b"]);
	// The original set is not changed.
	expect([...start]).toEqual(["a", "b"]);
});

test("a list's select-all box is off, dashed or ticked, and unavailable when nothing can be ticked", () => {
	const sets = pickables(backups()).filter((item) => item.target.kind === "set");
	const open = sets.filter((item) => item.blocked === null).map((item) => item.key);
	expect(allBoxState(sets, new Set())).toEqual({
		checked: false,
		indeterminate: false,
		unavailable: false,
	});
	expect(allBoxState(sets, new Set(open.slice(0, 1)))).toMatchObject({
		checked: false,
		indeterminate: true,
	});
	// The newest set is never ticked, so the others alone make the list all ticked.
	expect(allBoxState(sets, new Set(open))).toMatchObject({
		checked: true,
		indeterminate: false,
	});
	const onlyNewest = sets.filter((item) => item.blocked !== null);
	expect(allBoxState(onlyNewest, new Set()).unavailable).toBe(true);
});

test("kinds are counted in page order with their plurals", () => {
	expect(kindsText([DUMP, SET, DUMP])).toBe("1 backup set and 2 database dumps");
	expect(kindsText([KEPT, SNAP, SET, DUMP])).toBe(
		"1 backup set, 1 snapshot, 1 kept home and 1 database dump",
	);
});

test("one item's confirm names it; several name only their count and kinds", () => {
	expect(deleteCopy([DUMP]).title).toBe("Delete a.dump?");
	expect(deleteCopy([KEPT]).title).toBe("Delete the kept home of Alice?");

	const dumps = deleteCopy([DUMP, { kind: "dump", file: "b.dump" }]);
	expect(dumps.title).toBe("Delete 2 database dumps?");
	expect(dumps.description).toEqual(["The host removes the database dumps."]);
	expect(dumps.description.join(" ")).not.toContain("a.dump");

	const mixed = deleteCopy([DUMP, SET, SNAP, SET]);
	expect(mixed.title).toBe("Delete 4 items?");
	expect(mixed.description).toEqual([
		"2 backup sets, 1 snapshot and 1 database dump.",
		"Workspaces can no longer be restored from the deleted sets.",
		"Deleting a snapshot leaves its volume unchanged.",
		"The host removes the database dumps.",
	]);
});

test("a failure names the item it is about", () => {
	expect(targetName(DUMP)).toBe("a.dump");
	expect(targetName(SNAP)).toBe("Snapshot pre-x of v-home");
	expect(targetName(KEPT)).toBe("The kept home of Alice");
	expect(targetName(SET)).toMatch(/^The backup set from .* UTC$/);
});

test("the delete button says when the ticks reach past its own list", () => {
	expect(deleteSelectedText(2, 2)).toBe("Delete 2 selected…");
	expect(deleteSelectedText(3, 1)).toBe("Delete 3 selected on this tab…");
});

describe("the host's retention floor", () => {
	const complete = (stamp: string, requested?: boolean): HostBackupSet => ({
		stamp,
		complete: true,
		sizeBytes: 1,
		instances: [],
		failedVolumes: [],
		...(requested === undefined ? {} : { requested }),
	});
	const incomplete = (stamp: string): HostBackupSet => ({
		...complete(stamp),
		complete: false,
		failedVolumes: ["v-home"],
	});
	const host = (sets: HostBackupSet[], keepComplete?: number): AdminBackups["host"] => {
		const base = backups().host;
		if (!base) throw new Error("the fixture has a host");
		return {
			...base,
			sets,
			...(keepComplete === undefined ? {} : { floor: { keepComplete } }),
		};
	};
	const F = "20260928T000000Z";
	const E = "20260925T000000Z";
	const D = "20260920T000000Z";
	const C = "20260910T000000Z";
	const B = "20260905T000000Z";
	const A = "20260901T000000Z";

	test("keeps the newest N nightly sets; incomplete ones do not count toward N", () => {
		const reasons = floorReasons(
			host([incomplete(E), complete(D), incomplete(C), complete(B), complete(A)], 2),
		);
		expect([...reasons]).toEqual([
			[D, "Kept by the server: the newest 2 nightly sets"],
			[B, "Kept by the server: the newest 2 nightly sets"],
		]);
	});

	test("requested sets do not push nightly sets out, and can themselves be deleted", () => {
		const reasons = floorReasons(
			host(
				[
					complete(F, true),
					complete(E, true),
					complete(D),
					complete(C, false),
					complete(B),
					complete(A),
				],
				3,
			),
		);
		expect([...reasons.keys()]).toEqual([D, C, B]);
		expect(reasons.has(F)).toBe(false);
		expect(reasons.has(E)).toBe(false);
	});

	test("a floor of one, or none, still keeps the newest nightly set, as the host does", () => {
		for (const keep of [0, 1]) {
			const reasons = floorReasons(
				host([complete(C, true), complete(B), complete(A)], keep),
			);
			expect([...reasons]).toEqual([[B, "Kept by the server: the newest nightly set"]]);
		}
	});

	test("with no complete nightly set, the newest complete set of any kind is kept", () => {
		const reasons = floorReasons(
			host([complete(E, true), incomplete(D), complete(C, true)], 3),
		);
		expect([...reasons]).toEqual([[E, NEWEST_KEPT]]);
	});

	test("an older host that reports no floor protects only the newest complete set", () => {
		const reasons = floorReasons(host([incomplete(D), complete(C), complete(B)]));
		expect([...reasons]).toEqual([[C, NEWEST_KEPT]]);
		expect(floorReasons(null).size).toBe(0);
	});

	test("select all skips every set the floor protects", () => {
		const data = backups({
			host: host(
				[
					complete(F, true),
					complete(E),
					complete(D),
					incomplete(C),
					complete(B),
					complete(A),
				],
				3,
			),
		});
		const sets = pickables(data).filter((item) => item.target.kind === "set");
		const open = sets
			.filter((item) => item.blocked === null)
			.map((item) => item.target);
		expect(open).toEqual([
			{ kind: "set", stamp: F },
			{ kind: "set", stamp: C },
			{ kind: "set", stamp: A },
		]);
		const everyKey = withKeys(
			new Set(),
			sets.map((item) => item.key),
			true,
		);
		expect(pickedItems(sets, everyKey).map((item) => item.target)).toEqual(open);
		expect(
			allBoxState(sets, withKeys(new Set(), open.map(targetKey), true)).checked,
		).toBe(true);
	});
});
