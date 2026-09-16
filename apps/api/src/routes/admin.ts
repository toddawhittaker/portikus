import { requireRole } from "@portikus/auth";
import type { AdminWorkspaceList } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server.js";
import { countActive, toWorkspace } from "./workspace-view.js";

/** Administrator-only views (SPEC.md §5.2). */
export function registerAdminRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	app.get(
		"/admin/workspaces",
		{ preHandler: requireRole("administrator") },
		async () => {
			const rows = await db
				.selectFrom("workspaces")
				.selectAll()
				.orderBy("created_at")
				.execute();

			const workspaces = await Promise.all(
				rows.map(async (row) =>
					toWorkspace(
						row as Record<string, unknown>,
						await countActive(db, row.id as string, config),
						config,
					),
				),
			);

			const body: AdminWorkspaceList = { workspaces };
			return body;
		},
	);
}
