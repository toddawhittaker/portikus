import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** The LTI Deep Linking picker and its signed response (ADR 0058). No routes yet. */
export function registerLtiDeepLinkRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}
