import type { CourseLiveHelpDetail } from "@portikus/contracts";
import { expect, test } from "vitest";
import { ApiError } from "../../api/request.js";
import { type LiveListening, previewable } from "./previews.js";
import { sessionGone, studentAway } from "./queries.js";

function detail(studentConnected: boolean): CourseLiveHelpDetail {
	return {
		session: {
			id: "00000000-0000-4000-8000-000000000001",
			projectId: "00000000-0000-4000-8000-000000000002",
			projectName: "todo-api",
			userId: "00000000-0000-4000-8000-000000000003",
			displayName: "Ada",
			typing: false,
			startedAt: "2026-10-12T10:00:00.000Z",
			endsAt: "2026-10-12T11:00:00.000Z",
			workspaceState: "running",
		},
		studentConnected,
		terminals: [],
	};
}

test("the student is away when the last read says so", () => {
	expect(studentAway(detail(false), 100, null)).toBe(true);
	expect(studentAway(detail(true), 100, null)).toBe(false);
	expect(studentAway(undefined, 0, null)).toBe(false);
});

test("after a socket closed for the student leaving, only a later read can bring them back", () => {
	// The read from before the close is stale, even though it said connected.
	expect(studentAway(detail(true), 100, 200)).toBe(true);
	expect(studentAway(detail(true), 200, 200)).toBe(true);
	expect(studentAway(detail(true), 201, 200)).toBe(false);
	expect(studentAway(detail(false), 300, 200)).toBe(true);
});

test("only a 404 means the session is gone", () => {
	expect(sessionGone(new ApiError(404, "Not found.", "NOT_FOUND"))).toBe(true);
	expect(
		sessionGone(new ApiError(409, "The student is away.", "STUDENT_NOT_CONNECTED")),
	).toBe(false);
	expect(sessionGone(new Error("network"))).toBe(false);
});

function service(port: number, extra: Partial<LiveListening> = {}): LiveListening {
	return {
		port,
		previewReachability: "reachable",
		system: false,
		...extra,
	};
}

test("the preview list is the student's own reachable services, by port", () => {
	const list = previewable([
		service(8000),
		service(5355, { system: true }),
		service(22, { previewReachability: "denied" }),
		service(3000, { previewReachability: "forwarded" }),
	]);
	expect(list.map((item) => item.port)).toEqual([3000, 8000]);
});
