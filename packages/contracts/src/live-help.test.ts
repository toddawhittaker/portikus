import { expect, test } from "vitest";
import {
	CourseLiveHelpDetail,
	CourseLiveHelpResponse,
	LIVE_HELP_MINUTES,
	LiveHelpEndReason,
	LiveHelpStatus,
	LiveHelpTypingRequest,
	StartLiveHelpRequest,
} from "./live-help.js";
import { TerminalAttachMode } from "./terminal.js";

const ids = {
	session: "750e8400-e29b-41d4-a716-446655440000",
	project: "750e8400-e29b-41d4-a716-446655440001",
	course: "750e8400-e29b-41d4-a716-446655440002",
	helper: "750e8400-e29b-41d4-a716-446655440003",
	student: "750e8400-e29b-41d4-a716-446655440004",
	terminal: "750e8400-e29b-41d4-a716-446655440005",
};

const courseSession = {
	id: ids.session,
	projectId: ids.project,
	projectName: "Demo",
	userId: ids.student,
	displayName: "Sam Student",
	typing: false,
	startedAt: "2026-10-12T08:00:00.000Z",
	endsAt: "2026-10-12T09:00:00.000Z",
	workspaceState: "running",
};

test("a session lasts an hour", () => {
	expect(LIVE_HELP_MINUTES).toBe(60);
});

test("a student's status round-trips with an open session and the instructors to pick from", () => {
	const body = {
		session: {
			id: ids.session,
			projectId: ids.project,
			projectName: "Demo",
			courseId: ids.course,
			helper: { userId: ids.helper, displayName: "Ivy Instructor" },
			typing: true,
			startedAt: "2026-10-12T08:00:00.000Z",
			endsAt: "2026-10-12T09:00:00.000Z",
		},
		audience: [
			{
				courseId: ids.course,
				courseTitle: "CS 101",
				instructors: [{ userId: ids.helper, displayName: "Ivy Instructor" }],
			},
		],
	};
	expect(LiveHelpStatus.parse(body)).toEqual(body);
});

test("a student's status has a null session when nothing is open", () => {
	expect(LiveHelpStatus.parse({ session: null, audience: [] }).session).toBeNull();
});

test("the start body needs both ids and nothing else", () => {
	const body = { helperUserId: ids.helper, courseId: ids.course };
	expect(StartLiveHelpRequest.parse(body)).toEqual(body);
	expect(StartLiveHelpRequest.safeParse({ helperUserId: ids.helper }).success).toBe(
		false,
	);
	expect(StartLiveHelpRequest.safeParse({ ...body, typing: true }).success).toBe(false);
	expect(StartLiveHelpRequest.safeParse({ ...body, courseId: "nope" }).success).toBe(
		false,
	);
});

test("the typing body is one boolean", () => {
	expect(LiveHelpTypingRequest.parse({ typing: true })).toEqual({ typing: true });
	expect(LiveHelpTypingRequest.safeParse({ typing: "yes" }).success).toBe(false);
	expect(LiveHelpTypingRequest.safeParse({}).success).toBe(false);
});

test("the instructor's list and detail round-trip", () => {
	const list = { sessions: [courseSession] };
	expect(CourseLiveHelpResponse.parse(list)).toEqual(list);
	const detail = {
		session: courseSession,
		studentConnected: true,
		terminals: [{ id: ids.terminal, name: "Terminal 1" }],
	};
	expect(CourseLiveHelpDetail.parse(detail)).toEqual(detail);
});

test("attach modes are view and type only", () => {
	expect(TerminalAttachMode.options).toEqual(["view", "type"]);
	expect(TerminalAttachMode.safeParse("full").success).toBe(false);
});

test("end reasons match the audit's", () => {
	expect(LiveHelpEndReason.options).toEqual([
		"stopped",
		"helper_left",
		"archived",
		"helper_removed",
	]);
});
