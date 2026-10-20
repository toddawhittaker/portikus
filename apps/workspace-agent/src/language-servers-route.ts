import { join } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import { CloseCode, LanguageServerId } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AgentFailure } from "./errors.js";
import {
	EarlyMessages,
	LanguageServerHost,
	type LanguageServerHostOptions,
} from "./language-servers.js";
import { projectsDir, resolveProject } from "./projects.js";

export interface LanguageServersRouteOptions {
	homeDir: string;
	/** Overrides the host's table and timings. For tests. */
	host?: Omit<LanguageServerHostOptions, "log">;
}

/**
 * `GET /projects/:slug/language-servers/:server`: one LSP message per text
 * frame, to and from a server running in the project (SPEC.md §13.6). Token
 * auth is the server's own hook, upgrades included (SPEC.md §23.5).
 */
export async function languageServersRoute(
	instance: FastifyInstance,
	options: LanguageServersRouteOptions,
): Promise<void> {
	const host = new LanguageServerHost({ ...options.host, log: instance.log });

	instance.addHook("preClose", async () => {
		await host.closeEverything();
	});

	instance.get(
		"/projects/:slug/language-servers/:server",
		{ websocket: true },
		async (socket: WebSocket, request) => {
			const params = request.params as { slug: string; server: string };
			const early = new EarlyMessages(socket);
			const server = LanguageServerId.safeParse(params.server);
			if (!server.success) {
				socket.close(CloseCode.LANGUAGE_SERVER_UNAVAILABLE, "UNKNOWN_SERVER");
				return;
			}
			let projectPath: string;
			try {
				// Rejects a bad slug and a symlink out of ~/projects (SPEC.md §24.6).
				const project = await resolveProject(params.slug, options.homeDir);
				if (!project.exists) {
					socket.close(CloseCode.NOT_FOUND, "PROJECT_NOT_FOUND");
					return;
				}
				projectPath = project.path;
			} catch (error) {
				const code = error instanceof AgentFailure ? error.code : "SERVER_ERROR";
				socket.close(
					error instanceof AgentFailure ? CloseCode.POLICY : CloseCode.SERVER_ERROR,
					code,
				);
				return;
			}
			await host.attach(
				socket,
				{
					slug: params.slug,
					server: server.data,
					projectPath,
					// Not resolved: the browser maps URIs against the path the API reports.
					rootPath: join(projectsDir(options.homeDir), params.slug),
				},
				early,
			);
		},
	);
}
