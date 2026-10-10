import { expect, test } from "vitest";
import { AuthUser } from "./auth.js";
import {
	CourseMembersResponse,
	CoursesResponse,
	RosterSyncResponse,
} from "./courses.js";

const course = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	title: "CS 101 Intro to Programming",
	platformName: "Canvas",
};

const roster = { available: true, syncedAt: "2026-10-10T08:00:00.000Z", result: "ok" };

test("AuthUser accepts the instructor role", () => {
	expect(
		AuthUser.safeParse({
			id: course.id,
			email: null,
			displayName: "Ivy",
			role: "instructor",
			mustChangePassword: false,
			mustAcceptUse: false,
		}).success,
	).toBe(true);
});

test("CoursesResponse round-trips", () => {
	expect(CoursesResponse.parse([course])).toEqual([course]);
});

test("CourseMembersResponse accepts a member without a workspace", () => {
	const body = {
		course,
		roster,
		members: [
			{
				status: "active",
				userId: "650e8400-e29b-41d4-a716-446655440001",
				displayName: "Sam Student",
				role: "student",
				lastLaunchAt: "2026-09-23T12:00:00.000Z",
				workspaceState: null,
			},
			{
				status: "active",
				userId: "650e8400-e29b-41d4-a716-446655440002",
				displayName: "Ivy Instructor",
				role: "instructor",
				lastLaunchAt: "2026-09-23T12:00:00+00:00",
				workspaceState: "running",
			},
		],
	};
	expect(CourseMembersResponse.parse(body)).toEqual(body);
});

test("a course member is never an administrator", () => {
	const result = CourseMembersResponse.safeParse({
		course,
		roster,
		members: [
			{
				status: "active",
				userId: "650e8400-e29b-41d4-a716-446655440003",
				displayName: "Ada",
				role: "administrator",
				lastLaunchAt: "2026-09-23T12:00:00Z",
				workspaceState: null,
			},
		],
	});
	expect(result.success).toBe(false);
});

test("a not-started member has no account, launch or workspace", () => {
	const notStarted = {
		status: "not_started",
		userId: null,
		displayName: "Nora Newcomer",
		role: "student",
		lastLaunchAt: null,
		workspaceState: null,
	};
	const body = { course, roster, members: [notStarted] };
	expect(CourseMembersResponse.parse(body)).toEqual(body);
	for (const bad of [
		{ ...notStarted, userId: "650e8400-e29b-41d4-a716-446655440004" },
		{ ...notStarted, lastLaunchAt: "2026-09-23T12:00:00Z" },
		{ ...notStarted, workspaceState: "stopped" },
		// An active member must have launched.
		{ ...notStarted, status: "active" },
	]) {
		expect(
			CourseMembersResponse.safeParse({ course, roster, members: [bad] }).success,
		).toBe(false);
	}
});

test("roster state allows a course that has never synced or cannot", () => {
	for (const state of [
		{ available: false, syncedAt: null, result: null },
		{ available: true, syncedAt: "2026-10-10T08:00:00Z", result: "token_failed" },
	]) {
		expect(
			CourseMembersResponse.safeParse({ course, roster: state, members: [] }).success,
		).toBe(true);
	}
	expect(
		CourseMembersResponse.safeParse({
			course,
			roster: { available: true, syncedAt: null, result: "maybe" },
			members: [],
		}).success,
	).toBe(false);
});

test("RosterSyncResponse carries the outcome and whole-number counts", () => {
	const body = { roster, matched: 12, notStarted: 3, removed: 1, roleChanged: 0 };
	expect(RosterSyncResponse.parse(body)).toEqual(body);
	expect(RosterSyncResponse.safeParse({ ...body, removed: -1 }).success).toBe(false);
	expect(RosterSyncResponse.safeParse({ ...body, matched: 1.5 }).success).toBe(false);
});
