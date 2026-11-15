import {
	AgentUsageQuery,
	AgentUsageResponse,
	CourseLiveHelpDetail,
	CourseLiveHelpResponse,
	CourseMembersResponse,
	CourseProfileResponse,
	CourseSharesResponse,
	CoursesResponse,
	ListNotificationsQuery,
	MeResponse,
	NotificationList,
	RosterSyncResponse,
	SetCourseProfileRequest,
	SharedChecksResponse,
} from "@portikus/contracts";
import { z } from "zod";
import type { OperationRecords } from "../types.js";

// The route files validate these path parameters with schemas they keep to
// themselves, so the same shapes are written here (see each route's own
// `CourseParam`, `MemberParam`, `SessionParam` and `SharedParam`).
const CourseParam = z.object({ courseId: z.string().uuid() });
const MemberParam = z.object({
	courseId: z.string().uuid(),
	userId: z.string().uuid(),
});
const SessionParam = z.object({
	courseId: z.string().uuid(),
	sid: z.string().uuid(),
});
const SharedParam = z.object({
	courseId: z.string().uuid(),
	projectId: z.string().uuid(),
});

/** This family's operations, keyed by `"METHOD url"`. */
export const operations: OperationRecords = {
	"GET /courses": {
		name: "courses.list",
		description:
			"Lists the courses you teach, with each course's title, learning platform and whether it uses the agentic or traditional profile.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: {},
		output: CoursesResponse,
	},
	"GET /courses/:courseId/members": {
		name: "courses.members",
		description:
			"Lists the people in one of your courses, with each person's role, last sign-in and workspace state, plus whether the roster can be synced.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam },
		output: CourseMembersResponse,
	},
	"POST /courses/:courseId/members/:userId/remove": {
		name: "courses.remove_member",
		description:
			"Removes one student from your course; they are added back the next time they open the course from the learning platform.",
		risk: "change",
		audience: "instructor",
		tool: false,
		input: { params: MemberParam },
	},
	"PUT /courses/:courseId/profile": {
		name: "courses.set_profile",
		description:
			"Sets whether one of your courses uses the agentic or the traditional profile, and returns the new setting.",
		risk: "change",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam, body: SetCourseProfileRequest },
		output: CourseProfileResponse,
	},
	"POST /courses/:courseId/roster/sync": {
		name: "courses.sync_roster",
		description:
			"Asks the learning platform for the course's current roster and updates who is in the course, then returns how many people were matched, not started, removed or changed.",
		risk: "change",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam },
		output: RosterSyncResponse,
	},
	"GET /courses/:courseId/shares": {
		name: "shares.list",
		description:
			"Lists the projects that students in your course have shared with you for reading.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam },
		output: CourseSharesResponse,
	},
	"GET /courses/:courseId/shares/:projectId/checks": {
		name: "shares.checks",
		description:
			"Shows the names and latest results of the checks in one project a student shared with you, without the commands they run.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: SharedParam },
		output: SharedChecksResponse,
	},
	"GET /courses/:courseId/live-help": {
		name: "live_help.list",
		description:
			"Lists the live help sessions that students in your course have opened with you.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam },
		output: CourseLiveHelpResponse,
	},
	"GET /courses/:courseId/live-help/:sid": {
		name: "live_help.get",
		description:
			"Shows one live help session: the student, the project, when it ends, whether the student is connected, and the terminals you can join.",
		risk: "read",
		audience: "instructor",
		tool: false,
		input: { params: SessionParam },
		output: CourseLiveHelpDetail,
	},
	"POST /courses/:courseId/live-help/:sid/leave": {
		name: "live_help.leave",
		description: "Leaves one live help session you joined, which ends your help.",
		risk: "change",
		audience: "instructor",
		tool: false,
		input: { params: SessionParam },
	},
	"GET /courses/:courseId/live-help/:sid/listening": {
		name: "live_help.listening",
		description:
			"Lists the network services running in a live help student's workspace, so you can see which ones could be previewed.",
		risk: "read",
		audience: "instructor",
		tool: false,
		input: { params: SessionParam },
	},
	"GET /courses/:courseId/agent-usage": {
		name: "courses.agent_usage",
		description:
			"Shows how much the coding agents were used by the people in your course over the last 7, 30 or 90 days.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam, query: AgentUsageQuery },
		output: AgentUsageResponse,
	},
	"GET /auth/me": {
		name: "account.whoami",
		description:
			"Shows who this key acts as: the account's name, role and sign-in name.",
		risk: "read",
		audience: "staff",
		tool: true,
		input: {},
		output: MeResponse,
	},
	"GET /me/notifications": {
		name: "notifications.list",
		description:
			"Lists your most recent notifications, newest first, with the count of unread ones.",
		risk: "read",
		audience: "staff",
		tool: true,
		input: { query: ListNotificationsQuery },
		output: NotificationList,
	},
};
