import {
	AgentUsageQuery,
	AgentUsageResponse,
	CourseLiveHelpDetail,
	CourseLiveHelpResponse,
	CourseMembersResponse,
	CourseProfileResponse,
	CourseSharesResponse,
	CourseStuckResponse,
	CoursesResponse,
	ListNotificationsQuery,
	MeResponse,
	NotificationList,
	RosterSyncResponse,
	SetCourseProfileRequest,
	SharedChecksResponse,
} from "@portikus/contracts";
import {
	CourseMemberParam,
	CourseParam,
	CourseSessionParam,
	CourseSharedParam,
} from "../../http.js";
import type { OperationRecords } from "../types.js";

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
		risk: "destructive",
		audience: "instructor",
		tool: false,
		input: { params: CourseMemberParam },
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
		input: { params: CourseSharedParam },
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
		input: { params: CourseSessionParam },
		output: CourseLiveHelpDetail,
	},
	"POST /courses/:courseId/live-help/:sid/leave": {
		name: "live_help.leave",
		description: "Leaves one live help session you joined, which ends your help.",
		risk: "change",
		audience: "instructor",
		tool: false,
		input: { params: CourseSessionParam },
	},
	"GET /courses/:courseId/live-help/:sid/listening": {
		name: "live_help.listening",
		description:
			"Lists the network services running in a live help student's workspace, so you can see which ones could be previewed.",
		risk: "read",
		audience: "instructor",
		tool: false,
		input: { params: CourseSessionParam },
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
	"GET /courses/:courseId/stuck": {
		name: "courses.stuck",
		description:
			"Shows which students in one of your courses may be stuck, most likely first: failed checks in a row on projects they share with the course, live help requests in the course, and their overall coding-agent use across all courses over the last 7 days, with short reasons. Use it to answer who is stuck or struggling.",
		risk: "read",
		audience: "instructor",
		tool: true,
		input: { params: CourseParam },
		output: CourseStuckResponse,
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
