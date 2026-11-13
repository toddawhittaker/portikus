import type { CourseMember } from "@portikus/contracts";
import { describe, expect, it } from "vitest";
import {
	attentionFirst,
	filterMembers,
	needsAttention,
	waitingText,
} from "./memberFilter.js";

const at = "2026-11-12T07:00:00.000Z";
function member(
	userId: string,
	displayName: string,
	workspaceState: CourseMember["workspaceState"],
): CourseMember {
	return {
		status: "active",
		userId,
		displayName,
		role: "student",
		lastLaunchAt: at,
		workspaceState,
	};
}
const notStarted: CourseMember = {
	status: "not_started",
	userId: null,
	displayName: "Nia Never",
	role: "student",
	lastLaunchAt: null,
	workspaceState: null,
};
const ids = {
	ada: "00000000-0000-4000-8000-000000000001",
	bo: "00000000-0000-4000-8000-000000000002",
	cy: "00000000-0000-4000-8000-000000000003",
};
const members = [
	member(ids.ada, "Ada Lovelace", "running"),
	member(ids.bo, "Bo Stopped", "stopped"),
	member(ids.cy, "Cy Broken", "error"),
	notStarted,
];
const none = new Set<string>();

describe("filterMembers", () => {
	it("keeps everyone for All with no search", () => {
		expect(filterMembers(members, "all", "", none)).toHaveLength(4);
	});

	it("matches the name case-insensitively and ignores surrounding spaces", () => {
		expect(
			filterMembers(members, "all", "  ada ", none).map((m) => m.displayName),
		).toEqual(["Ada Lovelace"]);
	});

	it("filters by workspace state", () => {
		expect(
			filterMembers(members, "running", "", none).map((m) => m.displayName),
		).toEqual(["Ada Lovelace"]);
		expect(
			filterMembers(members, "stopped", "", none).map((m) => m.displayName),
		).toEqual(["Bo Stopped"]);
	});

	it("counts a failed workspace and a student waiting for live help as needing attention", () => {
		const waiting = new Set([ids.bo]);
		expect(
			filterMembers(members, "attention", "", waiting).map((m) => m.displayName),
		).toEqual(["Bo Stopped", "Cy Broken"]);
		expect(needsAttention(notStarted, waiting)).toBe(false);
	});

	it("counts students only in the state filters and gives instructors their own", () => {
		const teacher: CourseMember = {
			...member("00000000-0000-4000-8000-000000000009", "Ivy Teacher", "running"),
			role: "instructor",
		};
		const waiting = new Set([teacher.userId as string]);
		const roster = [...members, teacher];
		expect(filterMembers(roster, "all", "", waiting)).toHaveLength(5);
		expect(
			filterMembers(roster, "running", "", waiting).map((m) => m.displayName),
		).toEqual(["Ada Lovelace"]);
		expect(
			filterMembers(roster, "attention", "", waiting).map((m) => m.displayName),
		).toEqual(["Cy Broken"]);
		expect(
			filterMembers(roster, "instructors", "", waiting).map((m) => m.displayName),
		).toEqual(["Ivy Teacher"]);
	});

	it("lists only instructors under Instructors, never another kind of member", () => {
		// A role the course list may one day carry, such as a teaching assistant.
		const other = {
			...member("00000000-0000-4000-8000-000000000010", "Tam Assistant", "running"),
			role: "assistant",
		} as unknown as CourseMember;
		expect(filterMembers([...members, other], "instructors", "", new Set())).toEqual(
			[],
		);
	});

	it("combines the search with the filter", () => {
		expect(filterMembers(members, "attention", "ada", new Set([ids.bo]))).toEqual([]);
	});
});

describe("attentionFirst", () => {
	it("puts the longest wait first, then a failed workspace, then the rest in order", () => {
		const waiting = new Map([
			[ids.bo, "2026-11-12T07:10:00.000Z"],
			[ids.ada, "2026-11-12T07:20:00.000Z"],
		]);
		expect(attentionFirst(members, waiting).map((m) => m.displayName)).toEqual([
			"Bo Stopped",
			"Ada Lovelace",
			"Cy Broken",
			"Nia Never",
		]);
	});

	it("keeps the order when nobody needs attention", () => {
		const calm = [members[0], members[1], members[3]] as CourseMember[];
		expect(attentionFirst(calm, new Map())).toEqual(calm);
	});
});

describe("waitingText", () => {
	const now = Date.parse("2026-11-12T08:00:00.000Z");
	it("says how long, in minutes and then hours", () => {
		expect(waitingText("2026-11-12T07:59:30.000Z", now)).toBe("Waiting for help");
		expect(waitingText("2026-11-12T07:48:00.000Z", now)).toBe("Waiting 12 min");
		expect(waitingText("2026-11-12T06:55:00.000Z", now)).toBe("Waiting 1 h 5 min");
		expect(waitingText("2026-11-12T06:00:00.000Z", now)).toBe("Waiting 2 h");
	});
});
