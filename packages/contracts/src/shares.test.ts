import { expect, test } from "vitest";
import { TreeResponse } from "./files.js";
import { GitDiff, GitStatus } from "./git.js";
import {
	CourseSharesResponse,
	ProjectShareStatus,
	SharedChecksResponse,
	SharedGitDiffResponse,
	SharedGitStatusResponse,
	SharedTreeResponse,
} from "./shares.js";

const share = {
	id: "750e8400-e29b-41d4-a716-446655440000",
	startedAt: "2026-10-10T08:00:00.000Z",
	endsAt: "2026-10-11T08:00:00.000Z",
};

test("a share status round-trips with its viewers", () => {
	const body = {
		share,
		viewers: [
			{
				displayName: "Ivy Instructor",
				firstViewedAt: "2026-10-10T09:00:00.000Z",
				lastViewedAt: "2026-10-10T09:30:00.000Z",
			},
		],
		audience: [
			{
				courseId: "850e8400-e29b-41d4-a716-446655440000",
				courseTitle: "CS 101",
				instructors: ["Ivy Instructor"],
			},
		],
	};
	expect(ProjectShareStatus.parse(body)).toEqual(body);
	const empty = { share: null, viewers: [], audience: [] };
	expect(ProjectShareStatus.parse(empty)).toEqual(empty);
});

test("a viewer is shown by name only", () => {
	const parsed = ProjectShareStatus.parse({
		share,
		viewers: [
			{
				displayName: "Ivy",
				userId: "650e8400-e29b-41d4-a716-446655440001",
				email: "ivy@example.test",
				firstViewedAt: "2026-10-10T09:00:00Z",
				lastViewedAt: "2026-10-10T09:00:00Z",
			},
		],
		audience: [],
	});
	expect(Object.keys(parsed.viewers[0] ?? {}).sort()).toEqual([
		"displayName",
		"firstViewedAt",
		"lastViewedAt",
	]);
});

test("a course's shares round-trip", () => {
	const body = {
		shares: [
			{
				projectId: "750e8400-e29b-41d4-a716-446655440001",
				projectName: "Lab 1",
				userId: "650e8400-e29b-41d4-a716-446655440001",
				displayName: "Sam Student",
				startedAt: share.startedAt,
				endsAt: share.endsAt,
				workspaceState: "stopped",
			},
		],
	};
	expect(CourseSharesResponse.parse(body)).toEqual(body);
	expect(
		CourseSharesResponse.safeParse({
			shares: [{ ...body.shares[0], projectId: "lab-1" }],
		}).success,
	).toBe(false);
});

test("the shared reads answer in the owner's shapes", () => {
	expect(SharedTreeResponse).toBe(TreeResponse);
	expect(SharedGitStatusResponse).toBe(GitStatus);
	expect(SharedGitDiffResponse).toBe(GitDiff);
});

test("a shared check carries its name and latest run, never its command", () => {
	const body = {
		checks: [
			{
				id: "tests",
				name: "Tests",
				lastRun: { state: "passed", startedAt: share.startedAt, exitCode: 0 },
			},
			{ id: "lint", name: "Lint", lastRun: null },
		],
		error: null,
	};
	expect(SharedChecksResponse.parse(body)).toEqual(body);
	const withCommand = {
		...body,
		checks: [{ id: "lint", name: "Lint", command: "npm run lint", lastRun: null }],
	};
	expect(SharedChecksResponse.safeParse(withCommand).success).toBe(false);
});
