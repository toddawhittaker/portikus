import { requireUser } from "@portikus/auth";
import type { Database } from "@portikus/db";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { teachesCourse } from "./membership.js";

const CourseParam = z.object({ courseId: z.string().uuid() });

/**
 * The `:courseId` of a request whose caller teaches that course, or null:
 * for anyone else the course does not exist (ADR 0025).
 */
export async function taughtCourseId(
	db: Kysely<Database>,
	request: FastifyRequest,
): Promise<string | null> {
	const user = requireUser(request);
	const params = CourseParam.safeParse(request.params);
	if (!params.success) return null;
	const { courseId } = params.data;
	return (await teachesCourse(db, { userId: user.id, courseId })) ? courseId : null;
}
