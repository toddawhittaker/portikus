import { requireUser } from "@portikus/auth";
import {
	MAX_LAYOUT_BYTES_PER_USER,
	ProjectLayout,
	type SplitNode,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import type { ProjectRow, Scope } from "../workspaces/project-scope.js";
import type { WorkspaceHub } from "../workspaces/workspace-hub.js";

/** The layout version as an entity tag, so a save can name what it was based on. */
function layoutEtag(version: number): string {
	return `"${version}"`;
}

/** The version an If-Match header names, or null when it names none. */
function parseIfMatch(header: string | string[] | undefined): number | null {
	if (typeof header !== "string") return null;
	const match = /^"(\d{1,9})"$/.exec(header.trim());
	return match ? Number(match[1]) : null;
}

/** Terminal panes in one layout tab, for the debug line on a save. */
function countPanes(node: SplitNode): number {
	if (node.type === "leaf") return 1;
	if (node.type !== "split") return 0;
	return node.children.reduce((total, child) => total + countPanes(child), 0);
}

/** Layout bytes the user keeps in every project but `exceptProjectId`. */
async function otherLayoutBytes(
	db: Kysely<Database>,
	userId: string,
	exceptProjectId: string,
): Promise<number> {
	const row = await db
		.selectFrom("projects")
		.innerJoin("workspaces", "workspaces.id", "projects.workspace_id")
		.select(
			sql<string>`coalesce(sum(octet_length(projects.layout::text)), 0)::text`.as("n"),
		)
		.where("workspaces.owner_user_id", "=", userId)
		.where("projects.id", "!=", exceptProjectId)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

function layoutChanged(reply: FastifyReply) {
	return sendError(
		reply,
		412,
		"LAYOUT_CHANGED",
		"This project's layout was changed in another browser.",
	);
}

/** The saved layout of one project (SPEC.md §7.5). */
export function registerProjectLayoutRoutes(
	app: FastifyInstance,
	db: Kysely<Database>,
	hub: WorkspaceHub,
	limitWrites: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
	owned: (request: FastifyRequest, reply: FastifyReply) => Promise<Scope | null>,
	ownedProject: (
		workspaceId: string,
		projectId: string,
		reply: FastifyReply,
	) => Promise<ProjectRow | null>,
): void {
	app.get("/workspaces/:id/projects/:pid/layout", async (request, reply) => {
		const params = parseOr400(ProjectParam, request.params, reply);
		if (!params) return;
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.pid, reply);
		if (!row) return;
		reply.header("etag", layoutEtag(row.layout_version));
		reply.header("cache-control", "no-store");
		if (row.layout === null) return reply.status(204).send();
		return row.layout;
	});

	// A save names the version it was based on; a stale one is refused so it
	// cannot overwrite another browser's newer layout (SPEC.md §7.5).
	app.put(
		"/workspaces/:id/projects/:pid/layout",
		{ preHandler: limitWrites },
		async (request, reply) => {
			const params = parseOr400(ProjectParam, request.params, reply);
			if (!params) return;
			const scope = await owned(request, reply);
			if (!scope) return;
			const body = ProjectLayout.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await ownedProject(scope.workspaceId, params.pid, reply);
			if (!row) return;
			const basedOn = parseIfMatch(request.headers["if-match"]);
			if (basedOn === null || basedOn !== row.layout_version) {
				return layoutChanged(reply);
			}

			const text = JSON.stringify(body.data);
			const userId = requireUser(request).id;
			// A soft bound: two saves racing may pass it by one layout each.
			if (
				(await otherLayoutBytes(db, userId, row.id)) + Buffer.byteLength(text) >
				MAX_LAYOUT_BYTES_PER_USER
			) {
				return sendError(
					reply,
					413,
					"LAYOUT_LIMIT",
					"Your saved tab layouts have reached their size limit, so this layout was not saved. Close some tabs or delete projects you no longer need.",
				);
			}

			// The version guard makes the check and the write one step, so two
			// saves based on the same version cannot both land.
			const updated = await db
				.updateTable("projects")
				.set({ layout: text, layout_version: sql<number>`layout_version + 1` })
				.where("id", "=", row.id)
				.where("layout_version", "=", basedOn)
				.returning("layout_version")
				.executeTakeFirst();
			if (!updated) return layoutChanged(reply);
			hub.announceLayout(scope.workspaceId, row.id, updated.layout_version);

			request.log.debug(
				{
					workspaceId: scope.workspaceId,
					projectId: row.id,
					tabs: body.data.tabs.length,
					panes: body.data.tabs.reduce((total, tab) => total + countPanes(tab.root), 0),
				},
				"layout saved",
			);

			reply.header("etag", layoutEtag(updated.layout_version));
			return reply.status(204).send();
		},
	);
}
