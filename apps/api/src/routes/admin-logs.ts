import { requireRole } from "@portikus/auth";
import {
	type ApiError,
	LogCountsQuery,
	type LogPage,
	LogQuery,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LogCounter } from "../logs/counts.js";
import { readLogPage } from "../logs/filter.js";
import { JournalReader, LogsBusyError, LogsUnavailableError } from "../logs/journal.js";
import type { ServerDeps } from "../server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(
	reply: FastifyReply,
	status: number,
	code: ApiError["code"],
	message: string,
) {
	const body: ApiError = { code, message };
	return reply.status(status).header("cache-control", "no-store").send(body);
}

/** Map the reader's two failures to their answers; anything else is a real error. */
function sendReadFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
	if (error instanceof LogsBusyError) {
		return sendError(
			reply,
			429,
			"RATE_LIMITED",
			"Log search is busy. Try again in a moment.",
		);
	}
	if (error instanceof LogsUnavailableError) {
		request.log.warn(
			{ code: "LOGS_UNAVAILABLE", error: error.message },
			"logs unavailable",
		);
		return sendError(
			reply,
			503,
			"LOGS_UNAVAILABLE",
			"The platform's logs cannot be read right now. On the VM, journalctl still shows them.",
		);
	}
	throw error;
}

/**
 * `GET /admin/logs` and `GET /admin/logs/counts` (docs/adr/0036): the
 * platform's own JSON lines from the journal, redacted, for administrators.
 * Reading logs is not audited.
 */
export function registerAdminLogRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const reader = new JournalReader({ path: config.JOURNALCTL_PATH });
	const counter = new LogCounter(reader);

	app.get(
		"/admin/logs",
		{ preHandler: requireRole("administrator") },
		async (request, reply) => {
			const parsed = LogQuery.safeParse(request.query);
			if (!parsed.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid log query");
			}
			const query = parsed.data;

			let instanceName: string | null = null;
			if (query.workspace) {
				const row = await db
					.selectFrom("workspaces")
					.select("incus_instance_name")
					.where("id", "=", query.workspace)
					.executeTakeFirst();
				instanceName = row?.incus_instance_name ?? null;
			}

			let found: Awaited<ReturnType<typeof readLogPage>>;
			try {
				found = await readLogPage(reader, query, instanceName);
			} catch (error) {
				return sendReadFailure(request, reply, error);
			}

			// One query per page for the display names of the users on it.
			const userIds = [
				...new Set(
					found.lines
						.map(({ line }) => line.userId)
						.filter((id): id is string => typeof id === "string" && UUID.test(id)),
				),
			];
			const names = new Map<string, string>();
			if (userIds.length > 0) {
				const rows = await db
					.selectFrom("users")
					.select(["id", "display_name"])
					.where("id", "in", userIds)
					.execute();
				for (const row of rows) names.set(row.id, row.display_name);
			}

			const body: LogPage = {
				lines: found.lines.map(({ cursor, at, service, line }) => ({
					cursor,
					at: at.toISOString(),
					service,
					line,
					userName:
						typeof line.userId === "string" ? (names.get(line.userId) ?? null) : null,
				})),
				nextCursor: found.nextCursor,
				scanComplete: found.scanComplete,
				skippedLines: found.skippedLines,
			};
			return reply.header("cache-control", "no-store").send(body);
		},
	);

	app.get(
		"/admin/logs/counts",
		{ preHandler: requireRole("administrator") },
		async (request, reply) => {
			const parsed = LogCountsQuery.safeParse(request.query);
			if (!parsed.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid log counts query");
			}
			try {
				const body = await counter.counts(parsed.data.range);
				return reply.header("cache-control", "no-store").send(body);
			} catch (error) {
				return sendReadFailure(request, reply, error);
			}
		},
	);
}
