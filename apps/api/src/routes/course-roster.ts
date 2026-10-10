import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Roster sync for a course's instructors (ADR 0058). No routes yet. */
export function registerCourseRosterRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}
