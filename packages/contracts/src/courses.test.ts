import { expect, test } from "vitest";
import { AuthUser } from "./auth.js";
import { CourseMembersResponse, CoursesResponse } from "./courses.js";

const course = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	title: "CS 101 Intro to Programming",
	platformName: "Canvas",
};

test("AuthUser accepts the instructor role", () => {
	expect(
		AuthUser.safeParse({
			id: course.id,
			email: null,
			displayName: "Ivy",
			role: "instructor",
		}).success,
	).toBe(true);
});

test("CoursesResponse round-trips", () => {
	expect(CoursesResponse.parse([course])).toEqual([course]);
});

test("CourseMembersResponse accepts a member without a workspace", () => {
	const body = {
		course,
		members: [
			{
				displayName: "Sam Student",
				role: "student",
				lastLaunchAt: "2026-09-23T12:00:00.000Z",
				workspaceState: null,
			},
			{
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
		members: [
			{
				displayName: "Ada",
				role: "administrator",
				lastLaunchAt: "2026-09-23T12:00:00Z",
				workspaceState: null,
			},
		],
	});
	expect(result.success).toBe(false);
});
