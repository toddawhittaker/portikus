import { requireUser } from "@portikus/auth";
import {
	type AcceptableUseResponse,
	AcceptUseRequest,
	DEFAULT_ACCEPTABLE_USE_TEXT,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ServerDeps } from "../server.js";
import { sendError } from "./admin.js";
import { audit } from "./start-session.js";

/** The settings row's version; with no row yet it is the column default, 1. */
const CURRENT_VERSION = sql<number>`coalesce((select acceptable_use_version from settings where id = 1), 1)`;

/**
 * The acceptable-use statement and its acceptance (SPEC.md
 * section 5.1). Both routes are on the gate's allowed list.
 */
export function registerAcceptableUseRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db } = deps;

	app.get("/me/acceptable-use", async (_request, reply) => {
		const row = await db
			.selectFrom("settings")
			.select(["acceptable_use_text", "acceptable_use_version"])
			.where("id", "=", 1)
			.executeTakeFirst();
		const body: AcceptableUseResponse = {
			text: row?.acceptable_use_text ?? DEFAULT_ACCEPTABLE_USE_TEXT,
			version: row?.acceptable_use_version ?? 1,
		};
		return reply.send(body);
	});

	app.post("/me/acceptable-use", async (request, reply) => {
		const user = requireUser(request);
		const body = AcceptUseRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				body.error.issues[0]?.message ?? "Invalid request",
			);
		}
		const { version } = body.data;
		const accepted = await db.transaction().execute(async (trx) => {
			// One statement, so a text saved meanwhile can never be accepted unseen.
			const updated = await trx
				.updateTable("users")
				.set({
					acceptable_use_version: version,
					acceptable_use_accepted_at: new Date().toISOString(),
				})
				.where("id", "=", user.id)
				.where(sql<boolean>`${version} = ${CURRENT_VERSION}`)
				.executeTakeFirst();
			if (updated.numUpdatedRows === 0n) return false;
			await audit(
				trx,
				"user.acceptable_use_accepted",
				`user:${user.id}`,
				user.id,
				"ok",
				{
					version,
				},
			);
			return true;
		});
		if (!accepted) {
			return sendError(
				reply,
				409,
				"ACCEPTABLE_USE_CHANGED",
				"The statement has changed. Read the new one before you accept.",
			);
		}
		return reply.status(204).send();
	});
}
