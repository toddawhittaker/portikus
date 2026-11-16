import type { CourseStuckResponse, CourseStuckStudent } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import { taughtCourseId } from "../courses/membership.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { windowDays } from "../usage-window.js";

const DAYS = 7 as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Fewer failures in a row than this is ordinary trial and error. */
const STREAK_REASON = 3;

type Row = {
	user_id: string;
	display_name: string;
	streak: string | null;
	last_check_at: Date | null;
	help_open: string | null;
	help_recent: string | null;
	agent_sessions: string | null;
	agent_tokens: string | null;
	last_activity_at: Date;
};

function times(n: number): string {
	return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function reasonsFor(student: Omit<CourseStuckStudent, "reasons">, now: Date): string[] {
	const reasons: string[] = [];
	if (student.liveHelpOpen > 0) reasons.push("has live help open");
	if (student.failingStreak >= STREAK_REASON)
		reasons.push(`${student.failingStreak} failed checks in a row`);
	if (student.liveHelpRecent > 0)
		reasons.push(`asked for help ${times(student.liveHelpRecent)} in ${DAYS} days`);
	const last = student.lastActivityAt ? Date.parse(student.lastActivityAt) : 0;
	if (now.getTime() - last > DAYS * DAY_MS) reasons.push(`no activity in ${DAYS} days`);
	return reasons;
}

/** Most likely stuck first: open help, then the longest failing streak, then help asked, then the quietest. */
function stuckFirst(a: CourseStuckStudent, b: CourseStuckStudent): number {
	return (
		b.liveHelpOpen - a.liveHelpOpen ||
		b.failingStreak - a.failingStreak ||
		b.liveHelpRecent - a.liveHelpRecent ||
		(a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? "") ||
		a.displayName.localeCompare(b.displayName) ||
		a.userId.localeCompare(b.userId)
	);
}

/**
 * Each student of the course with their check failures, live help requests
 * and coding-agent use (SPEC.md section 20.5). Counts and times only: no
 * file contents, check output, or chat text. Checks count only on projects
 * the student shares with the course, the same gate as reading a shared
 * project's checks; agent use is the student's overall use (ADR 0057).
 */
export async function courseStuck(
	db: Kysely<Database>,
	courseId: string,
	now: Date,
): Promise<CourseStuckResponse> {
	const since = new Date(now.getTime() - DAYS * DAY_MS);
	const fromDay = windowDays(DAYS, now).from;
	const { rows } = await sql<Row>`
		with students as (
			select m.user_id, m.last_launch_at, u.display_name
			from lti_memberships m join users u on u.id = m.user_id
			where m.context_id = ${courseId} and m.role = 'student'
		),
		runs as (
			select w.owner_user_id as user_id, r.state, r.ended_at
			from check_runs r
			join projects p on p.id = r.project_id
			join workspaces w on w.id = p.workspace_id
			join students s on s.user_id = w.owner_user_id
			where r.state <> 'stopped' and p.state = 'active'
				and exists (
					select 1 from project_shares ps
					where ps.project_id = p.id and ps.ended_at is null and ps.ends_at > ${now}
				)
		),
		passes as (
			select user_id, max(ended_at) as at from runs where state = 'passed' group by user_id
		),
		checks as (
			select r.user_id, max(r.ended_at) as last_check_at,
				count(*) filter (
					where r.state <> 'passed' and r.ended_at > coalesce(p.at, '-infinity'::timestamptz)
				) as streak
			from runs r left join passes p on p.user_id = r.user_id
			group by r.user_id
		),
		help as (
			select w.owner_user_id as user_id,
				count(*) filter (where h.ended_at is null and h.ends_at > ${now}) as open,
				count(*) filter (where h.started_at > ${since}) as recent,
				max(h.started_at) as last_at
			from live_help_sessions h join workspaces w on w.id = h.workspace_id
			where h.course_id = ${courseId}
			group by w.owner_user_id
		),
		agent as (
			select user_id, sum(sessions) as sessions,
				sum(input_tokens + output_tokens) as tokens, max(day) as last_day
			from agent_usage_days
			where day >= ${fromDay}::date and user_id in (select user_id from students)
			group by user_id
		)
		select s.user_id, s.display_name,
			c.streak::text as streak, c.last_check_at,
			h.open::text as help_open, h.recent::text as help_recent,
			a.sessions::text as agent_sessions, a.tokens::text as agent_tokens,
			greatest(s.last_launch_at, c.last_check_at, h.last_at, a.last_day::timestamptz)
				as last_activity_at
		from students s
		left join checks c on c.user_id = s.user_id
		left join help h on h.user_id = s.user_id
		left join agent a on a.user_id = s.user_id
	`.execute(db);
	const students = rows.map((row) => {
		const base = {
			userId: row.user_id,
			displayName: row.display_name,
			failingStreak: Number(row.streak ?? 0),
			lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
			liveHelpOpen: Number(row.help_open ?? 0),
			liveHelpRecent: Number(row.help_recent ?? 0),
			agentSessions: Number(row.agent_sessions ?? 0),
			agentTokens: Number(row.agent_tokens ?? 0),
			lastActivityAt: row.last_activity_at
				? new Date(row.last_activity_at).toISOString()
				: null,
		};
		return { ...base, reasons: reasonsFor(base, now) };
	});
	return { days: DAYS, students: students.sort(stuckFirst) };
}

/** "Who is stuck?" for a course's instructors (SPEC.md section 20.5). */
export function registerCourseStuckRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	app.get("/courses/:courseId/stuck", async (request, reply) => {
		const courseId = await taughtCourseId(db, request);
		if (!courseId) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		return reply.send(await courseStuck(db, courseId, new Date()));
	});
}
