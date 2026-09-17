import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
	countActive,
	findOwnedWorkspace,
	findWorkspaceOwnedBy,
} from "./workspace-view.js";

/**
 * Browser presence for a workspace (SPEC.md §6.4). Both the workspace socket
 * and a terminal attachment register here, so a terminal alone keeps the
 * workspace running and cancels the shutdown timer.
 */
export async function openPresence(
	db: Kysely<Database>,
	workspaceId: string,
	connectionId: string,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.insertInto("workspace_connections")
		.values({ id: connectionId, workspace_id: workspaceId })
		.execute();

	await db
		.updateTable("workspaces")
		.set({
			desired_state: "running",
			last_active_connection_at: now,
			updated_at: now,
		})
		.where("id", "=", workspaceId)
		.execute();
}

/** Remove one presence row when its socket goes away. */
export async function dropPresence(
	db: Kysely<Database>,
	connectionId: string,
): Promise<void> {
	await db.deleteFrom("workspace_connections").where("id", "=", connectionId).execute();
}

/** Keep a presence row fresh while its socket stays open. */
export async function touchPresence(
	db: Kysely<Database>,
	connectionId: string,
): Promise<void> {
	await db
		.updateTable("workspace_connections")
		.set({ last_seen_at: new Date().toISOString() })
		.where("id", "=", connectionId)
		.execute();
}

/** Concurrent sockets allowed per workspace (SPEC.md §24.2). */
export const MAX_CONNECTIONS_PER_WORKSPACE = 16;

declare module "fastify" {
	interface FastifyRequest {
		/** The workspace row the upgrade guard already loaded and authorized. */
		workspaceRow?: Record<string, unknown>;
	}
}

const UpgradeParams = z.object({ id: z.string().uuid() });

/**
 * The shared preHandler for a workspace WebSocket upgrade: validate the id,
 * load the workspace the caller may see, and refuse a workspace that already
 * has too many sockets (SPEC.md §5.3, §24.2). The row it loaded is left on the
 * request so the handler never has to re-query without an ownership filter.
 *
 * Terminal sockets pass `ownerOnly`, because an administrator may look at a
 * workspace but must not attach to a student's terminal (SPEC.md §20.2).
 */
export function workspaceUpgradeGuard(
	db: Kysely<Database>,
	config: ApiConfig,
	options: { ownerOnly: boolean },
): preHandlerAsyncHookHandler {
	return async (request, reply) => {
		const user = requireUser(request);
		const params = UpgradeParams.safeParse(request.params);
		if (!params.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: params.error.message });
		}
		const row = options.ownerOnly
			? await findWorkspaceOwnedBy(db, params.data.id, user.id)
			: await findOwnedWorkspace(db, user, params.data.id);
		if (!row) {
			return reply
				.status(404)
				.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
		}
		const active = await countActive(db, params.data.id, config);
		if (active >= MAX_CONNECTIONS_PER_WORKSPACE) {
			return reply.status(429).send({
				code: "TOO_MANY_CONNECTIONS",
				message: "This workspace already has too many open connections",
			});
		}
		request.workspaceRow = row;
	};
}

/**
 * Work a socket starts outlives the request that caused it, so shutdown has to
 * drain it: a query that outlives the pool leaves its connection checked out,
 * and closing the pool then waits for that connection forever.
 */
export function createPendingWork(): {
	track: (work: Promise<unknown>) => void;
	drain: () => Promise<void>;
} {
	const pending = new Set<Promise<unknown>>();
	return {
		track(work) {
			pending.add(work);
			void work.finally(() => pending.delete(work));
		},
		async drain() {
			// A handler already running can start more work, so keep draining.
			while (pending.size > 0) {
				await Promise.allSettled([...pending]);
			}
		},
	};
}
