import { requireRole, requireUser } from "@portikus/auth";
import {
	normalizePriceRow,
	PriceProposalDecision,
	PriceRowInput,
	type PricingTable,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import { errorMessage } from "@portikus/observability";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { startPriceRun } from "../pricing/run.js";
import {
	figureColumns,
	latestRun,
	listPrices,
	pendingProposals,
	withoutId,
} from "../pricing/store.js";

const adminOnly = { preHandler: requireRole("administrator") };

/**
 * The model price table (SPEC.md sections 10.8 and 20.4): administrators
 * check prices with the model, decide each proposal, and edit rows by hand;
 * any signed-in user reads the table for the restart estimate.
 */
export function registerAdminPricingRoutes(
	app: FastifyInstance,
	{ db, config, logger }: ServerDeps,
): void {
	app.get("/pricing", async (request, reply) => {
		requireUser(request);
		const table: PricingTable = { prices: (await listPrices(db)).map(withoutId) };
		return reply.header("cache-control", "no-store").send(table);
	});

	app.get("/admin/pricing", adminOnly, async (_request, reply) => {
		return reply.header("cache-control", "no-store").send({
			prices: await listPrices(db),
			run: await latestRun(db),
			proposals: await pendingProposals(db),
		});
	});

	app.post("/admin/pricing/refresh", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const started = await startPriceRun({ db, config }, "manual", admin.id);
		if ("refused" in started) {
			return started.refused === "running"
				? sendError(
						reply,
						409,
						"OPERATION_IN_PROGRESS",
						"A price check is already running.",
					)
				: sendError(reply, 409, "AGENT_UNAVAILABLE", started.reason);
		}
		started.done.catch((error: unknown) =>
			logger.error({ error: errorMessage(error) }, "price check error"),
		);
		return reply.status(202).header("cache-control", "no-store").send(started.run);
	});

	app.post(
		"/admin/pricing/proposals/:id/decision",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = parseOr400(UuidParam, request.params, reply);
			if (!params) return reply;
			const body = parseOr400(PriceProposalDecision, request.body ?? {}, reply);
			if (!body) return reply;
			const decided = await db.transaction().execute(async (trx) => {
				type Outcome = "decided" | "missing" | "needs-output-price";
				const proposal = await trx
					.selectFrom("price_proposals")
					.selectAll()
					.where("id", "=", params.id)
					.where("status", "=", "pending")
					.forUpdate()
					.executeTakeFirst();
				if (!proposal) return "missing" satisfies Outcome;
				const accepted = body.decision === "accept";
				// A proposal from before output prices existed has none; the admin must supply it.
				const outputPrice =
					proposal.output_price_per_million ?? body.outputPricePerMillion ?? null;
				if (accepted && outputPrice === null)
					return "needs-output-price" satisfies Outcome;
				const now = new Date().toISOString();
				await trx
					.updateTable("price_proposals")
					.set({
						status: accepted ? "accepted" : "rejected",
						decided_by: admin.id,
						decided_at: now,
					})
					.where("id", "=", proposal.id)
					.execute();
				if (accepted) {
					const {
						id: _id,
						run_id,
						status,
						decided_by,
						decided_at,
						...proposed
					} = proposal;
					const figures = { ...proposed, output_price_per_million: outputPrice };
					await trx
						.insertInto("model_prices")
						.values({
							...figures,
							checked_at: now,
							updated_at: now,
							updated_by: admin.id,
						})
						.onConflict((oc) =>
							oc.columns(["provider", "model"]).doUpdateSet({
								...figures,
								checked_at: now,
								updated_at: now,
								updated_by: admin.id,
							}),
						)
						.execute();
				}
				await recordAudit(trx, {
					actor: `user:${admin.id}`,
					target: `price_proposal:${proposal.id}`,
					action: "pricing.proposal_decided",
					result: "ok",
					metadata: {
						decision: accepted ? "accepted" : "rejected",
						provider: proposal.provider,
						model: proposal.model,
					},
				});
				return "decided" satisfies Outcome;
			});
			if (decided === "missing")
				return sendError(reply, 404, "NOT_FOUND", "No pending proposal with that id.");
			if (decided === "needs-output-price")
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"This proposal has no output price. Enter one to accept it.",
				);
			return reply.header("cache-control", "no-store").send({
				prices: await listPrices(db),
				proposals: await pendingProposals(db),
			});
		},
	);

	async function rowChanged(
		adminId: string,
		rowId: string,
		change: "added" | "edited" | "deleted",
		row: { provider: string; model: string },
	) {
		await recordAudit(db, {
			actor: `user:${adminId}`,
			target: `model_price:${rowId}`,
			action: "pricing.row_changed",
			result: "ok",
			metadata: { change, provider: row.provider, model: row.model },
		});
	}

	const sendTable = async (reply: FastifyReply, status = 200) =>
		reply
			.status(status)
			.header("cache-control", "no-store")
			.send({ prices: await listPrices(db) });

	app.post("/admin/pricing/rows", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const parsed = parseOr400(PriceRowInput, request.body ?? {}, reply);
		if (!parsed) return reply;
		const row = normalizePriceRow(parsed);
		const inserted = await db
			.insertInto("model_prices")
			.values({ ...figureColumns(row), updated_by: admin.id })
			.onConflict((oc) => oc.columns(["provider", "model"]).doNothing())
			.returning("id")
			.executeTakeFirst();
		if (!inserted) {
			return sendError(
				reply,
				409,
				"BUSY",
				"That model already has a row. Edit the row instead.",
			);
		}
		await rowChanged(admin.id, inserted.id, "added", row);
		return sendTable(reply, 201);
	});

	app.put("/admin/pricing/rows/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return reply;
		const parsed = parseOr400(PriceRowInput, request.body ?? {}, reply);
		if (!parsed) return reply;
		const row = normalizePriceRow(parsed);
		const now = new Date().toISOString();
		let updated: { id: string } | undefined;
		try {
			updated = await db
				.updateTable("model_prices")
				.set({
					...figureColumns(row),
					checked_at: now,
					updated_at: now,
					updated_by: admin.id,
				})
				.where("id", "=", params.id)
				.returning("id")
				.executeTakeFirst();
		} catch (error) {
			if ((error as { code?: string }).code !== "23505") throw error;
			return sendError(reply, 409, "BUSY", "Another row already has that model.");
		}
		if (!updated)
			return sendError(reply, 404, "NOT_FOUND", "No price row with that id.");
		await rowChanged(admin.id, updated.id, "edited", row);
		return sendTable(reply);
	});

	app.delete("/admin/pricing/rows/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return reply;
		const deleted = await db
			.deleteFrom("model_prices")
			.where("id", "=", params.id)
			.returning(["id", "provider", "model"])
			.executeTakeFirst();
		if (!deleted)
			return sendError(reply, 404, "NOT_FOUND", "No price row with that id.");
		await rowChanged(admin.id, deleted.id, "deleted", deleted);
		return sendTable(reply);
	});
}
