import { randomUUID } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import { requireRole, requireUser } from "@portikus/auth";
import {
	CloseCode,
	type RootShellCloseReason,
	RootShellStatus,
	TerminalSizeQuery,
} from "@portikus/contracts";
import { notifyAdministrators, recordAudit } from "@portikus/db";
import { readNotifyFile } from "@portikus/observability";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { encodeJsonFrame, FrameType } from "../root-shell/frames.js";
import { connectRootShellHelper } from "../root-shell/helper-client.js";
import { pipeRootShell, type RootShellPipe } from "../root-shell/pipe.js";
import { createPendingWork } from "../workspaces/presence.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";

/** The longest user agent an audit row keeps. */
const MAX_USER_AGENT_LENGTH = 256;

/**
 * Root shells for administrators (ADR 0051; SPEC.md §20.3, §24.11). Each
 * browser socket is one helper connection and one shell; the API never runs
 * as root itself.
 */
export function registerAdminRootShellRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;
	const enabled = config.ROOT_SHELL_SOCKET !== "";
	const live = new Set<RootShellPipe>();
	const { track, drain } = createPendingWork();

	app.get("/admin/root-shell", { preHandler: requireRole("administrator") }, async () =>
		RootShellStatus.parse({ enabled }),
	);

	/** The optional alert on open (ADR 0051 decision 7); a failure never blocks the shell. */
	async function alertIfOn(request: FastifyRequest, name: string): Promise<void> {
		try {
			const settings = await readNotifyFile(config.NOTIFY_FILE);
			if (!settings.rootShellOpenedAlert) return;
			await notifyAdministrators(db, {
				tone: "warning",
				title: `Root shell opened by ${name}`,
				body: "An administrator opened a root shell on the server from the admin page.",
			});
		} catch (error) {
			request.log.warn({ err: error }, "root shell open alert failed");
		}
	}

	app.get(
		"/admin/root-shell/ws",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				requireRole("administrator"),
				async (_request, reply) => {
					if (!enabled) {
						return sendError(reply, 404, "NOT_FOUND", "Root shells are turned off.");
					}
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			// Hold browser frames until the pipe's listeners are attached.
			socket.pause();
			const admin = requireUser(request);
			const size = TerminalSizeQuery.parse(request.query ?? {});

			if (!terminalSockets.take(admin.id)) {
				socket.close(CloseCode.TOO_MANY_SOCKETS, "too many terminal connections");
				socket.resume();
				return;
			}

			const shellId = randomUUID();
			const opened = Date.now();
			const actor = `user:${admin.id}`;
			try {
				// No audit row, no shell (ADR 0051 decision 6).
				await recordAudit(db, {
					actor,
					target: shellId,
					action: "admin.root_shell_opened",
					result: "ok",
					metadata: {
						shellId,
						address: request.ip,
						userAgent: (request.headers["user-agent"] ?? "").slice(
							0,
							MAX_USER_AGENT_LENGTH,
						),
					},
				});
			} catch (error) {
				terminalSockets.release(admin.id);
				request.log.error({ err: error }, "root shell refused: audit write failed");
				socket.close(CloseCode.SERVER_ERROR, "root shell unavailable");
				socket.resume();
				return;
			}

			async function recordClosed(reason: RootShellCloseReason): Promise<void> {
				try {
					await recordAudit(db, {
						actor,
						target: shellId,
						action: "admin.root_shell_closed",
						result: "ok",
						metadata: {
							shellId,
							reason,
							durationSeconds: Math.round((Date.now() - opened) / 1000),
						},
					});
				} catch (error) {
					request.log.error({ err: error, shellId }, "root shell close audit failed");
				}
			}

			track(alertIfOn(request, admin.displayName));

			let pipe: RootShellPipe;
			try {
				const helper = await connectRootShellHelper(config.ROOT_SHELL_SOCKET);
				helper.write(
					encodeJsonFrame(FrameType.OPEN, {
						shellId,
						actorId: admin.id,
						actorName: admin.displayName,
						address: request.ip,
						cols: size.cols,
						rows: size.rows,
					}),
				);
				pipe = pipeRootShell({
					db,
					socket,
					helper,
					sessionToken: request.sessionToken,
					shellId,
					log: request.log,
				});
			} catch (error) {
				terminalSockets.release(admin.id);
				request.log.error({ err: error, shellId }, "root shell helper unavailable");
				socket.close(CloseCode.SERVER_ERROR, "root shell unavailable");
				socket.resume();
				track(recordClosed("exit"));
				return;
			}

			live.add(pipe);
			track(
				pipe.done.then(async (reason) => {
					live.delete(pipe);
					terminalSockets.release(admin.id);
					await recordClosed(reason);
				}),
			);
			socket.resume();
		},
	);

	// Each shell ends as api_stopped, and its closed row is written before the
	// database pool closes.
	app.addHook("preClose", async () => {
		for (const pipe of live) pipe.stop();
	});
	app.addHook("onClose", drain);
}
