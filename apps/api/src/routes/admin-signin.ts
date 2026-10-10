import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Choosing the sign-in provider as a trial, checked by a test sign-in (SPEC.md 20.1, ADR 0059). */
export function registerAdminSigninRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}
