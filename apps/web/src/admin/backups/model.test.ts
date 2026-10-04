import type { BackupRequestView } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	newestCompleteStamp,
	requestText,
	runningText,
	stampIso,
	stateText,
	waitingRequest,
	workspaceName,
} from "./model.js";
import { BOB_INSTANCE, backups, NEW, view, WORKSPACES } from "./testBackups.js";

test("a stamp reads as its UTC time", () => {
	expect(stampIso(NEW)).toBe("2026-09-24T02:30:00Z");
});

test("the newest complete set is the one the host keeps", () => {
	expect(newestCompleteStamp(backups().host?.sets ?? [])).toBe(NEW);
	expect(newestCompleteStamp([])).toBeNull();
});

test("requests read in words, naming the workspace", () => {
	const copy = backups().requests[0] as BackupRequestView;
	expect(requestText(copy, WORKSPACES)).toMatch(
		/^Restore Alice Smith \(alice\) from .* into ~\/restored-2026-09-24-0230$/,
	);
	expect(requestText(view({ kind: "delete_dump", args: { file: "x.dump" } }), [])).toBe(
		"Delete dump x.dump",
	);
	expect(
		requestText(view({ kind: "delete_kept_home", args: { volume: "v" } }), []),
	).toBe("Delete kept home v");
	expect(
		requestText(
			view({ kind: "delete_snapshot", args: { volume: "v", snapshot: "pre-a" } }),
			[],
		),
	).toBe("Delete snapshot pre-a of v");
	expect(
		requestText(
			view({ kind: "import_home", args: { instance: BOB_INSTANCE } }),
			WORKSPACES,
		),
	).toBe("Import the home of Bob Jones (bob)");
	expect(workspaceName("ws-unknown", [])).toBe("ws-unknown");
	expect(stateText(view({ state: "pending" }))).toBe("Waiting for the host");
	expect(stateText(view({ state: "pending", kind: "delete_snapshot" }))).toBe(
		"Waiting for the platform",
	);
	expect(stateText(view({ state: "claimed" }))).toBe("Running");
	expect(stateText(view({ state: "failed" }))).toBe("Failed");
});

test("running now names the nightly run or the request", () => {
	const pending = view({ state: "pending" });
	expect(runningText(null, [], [])).toBe("Nothing");
	expect(runningText("nightly", [], [])).toBe("The nightly backup");
	expect(runningText(pending.id, [pending], [])).toBe("Back up now");
	expect(runningText("ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", [], [])).toBe(
		"A requested job",
	);
	expect(waitingRequest([pending], "backup")).toBe(pending);
	expect(waitingRequest([pending], "delete_set")).toBeUndefined();
});
