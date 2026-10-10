import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Linking and unlinking a course account and an SSO account for someone else (SPEC.md 20.1, ADR 0026). */
export function registerAdminAccountLinkRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}
