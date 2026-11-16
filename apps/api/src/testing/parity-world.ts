import type { Database } from "@portikus/db";
import { insertTestLtiMembership, insertTestUser } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { splitKey } from "../route-policy.js";
import { buildMatrixWorld, type MatrixWorld } from "./test-support.js";

/**
 * The world the catalog parity tests share: the matrix world plus a second
 * course, and the path values and answers each request is built from and
 * compared by (SPEC.md sections 20.5 and 24.8).
 */

/** The matrix instructor's mock subject. */
export const INSTRUCTOR = "ivy";

/** The ids a course route names: a member, a shared project and a live help session. */
export interface CourseTarget {
	courseId: string;
	userId: string;
	projectId: string;
	sid: string;
}

/**
 * The matrix world plus a second course. The matrix instructor teaches the
 * first, where A is a student with a shared project and live help open; a
 * different instructor teaches the second, where B has the same.
 */
export type ParityWorld = MatrixWorld & { own: CourseTarget; other: CourseTarget };

export async function userIdOf(db: Kysely<Database>, subject: string): Promise<string> {
	const row = await db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", subject)
		.executeTakeFirstOrThrow();
	return row.id;
}

async function openShareAndHelp(
	db: Kysely<Database>,
	student: MatrixWorld["a"],
	courseId: string,
	helperId: string,
): Promise<string> {
	const endsAt = new Date(Date.now() + 3_600_000).toISOString();
	await db
		.insertInto("project_shares")
		.values({ project_id: student.projectId, ends_at: endsAt })
		.execute();
	const help = await db
		.insertInto("live_help_sessions")
		.values({
			workspace_id: student.workspaceId,
			project_id: student.projectId,
			helper_user_id: helperId,
			course_id: courseId,
			ends_at: endsAt,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return help.id;
}

export async function buildParityWorld(
	app: FastifyInstance,
	db: Kysely<Database>,
	agentToken: string,
): Promise<ParityWorld> {
	const matrix = await buildMatrixWorld(app, db, agentToken);
	// Teaches the second course; the matrix instructor does not.
	const otherInstructorId = await insertTestUser(db, { role: "instructor" });
	const otherCourseId = await insertTestLtiMembership(db, otherInstructorId, {
		contextId: "course-2",
		title: "Another Course",
		role: "instructor",
	});
	await insertTestLtiMembership(db, matrix.b.userId, { contextId: "course-2" });
	return {
		...matrix,
		own: {
			courseId: matrix.courseId,
			userId: matrix.a.userId,
			projectId: matrix.a.projectId,
			sid: await openShareAndHelp(
				db,
				matrix.a,
				matrix.courseId,
				await userIdOf(db, INSTRUCTOR),
			),
		},
		other: {
			courseId: otherCourseId,
			userId: matrix.b.userId,
			projectId: matrix.b.projectId,
			sid: await openShareAndHelp(db, matrix.b, otherCourseId, otherInstructorId),
		},
	};
}

/** The value for each path parameter of a route, aimed at A or at the chosen course. */
export function pathValues(
	key: string,
	world: ParityWorld,
	course: CourseTarget,
): Record<string, string> {
	const { url } = splitKey(key);
	const values: Record<string, string> = {};
	for (const [, name] of url.matchAll(/:([A-Za-z0-9_]+)/g)) {
		if (name === undefined) continue;
		values[name] =
			{
				id:
					url.startsWith("/admin/users/:id") || url.startsWith("/admin/dex-users/:id")
						? world.a.userId
						: world.a.workspaceId,
				// A process id is a number inside the workspace.
				pid: url.includes("/processes/:pid") ? "7" : world.a.projectId,
				tid: world.a.terminalId,
				checkId: "lint",
				courseId: course.courseId,
				userId: course.userId,
				projectId: course.projectId,
				courseUserId: world.a.userId,
				sid: course.sid,
				port: "5173",
				server: "python",
				// Forms the operation's params schema accepts, so the runner sends them.
				stamp: "20260101T000000Z",
				file: "portikus-pre-x.dump",
				volume: url.includes("/kept-homes/")
					? "ws-000000000000000000000000-home-replaced-1"
					: "ws-000000000000000000000000-home",
				snapshot: "pre-x",
			}[name] ?? name;
	}
	return values;
}

export function fillPath(key: string, values: Record<string, string>): string {
	return splitKey(key)
		.url.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) =>
			encodeURIComponent(values[name] ?? name),
		)
		.replace("*", "index.html");
}

export interface Answer {
	status: number;
	code?: string;
}

export function codeOf(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return typeof parsed.code === "string" ? parsed.code : undefined;
	} catch {
		return undefined;
	}
}

export function answerOf(status: number, body: string): Answer {
	return status < 400 ? { status } : { status, code: codeOf(body) };
}
