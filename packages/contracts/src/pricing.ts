import { z } from "zod";
import { AiBaseUrl } from "./ai.js";

/** Whose API price list a row comes from; prices are API prices only. */
export const PriceProvider = z.enum(["anthropic", "openai"]);
export type PriceProvider = z.infer<typeof PriceProvider>;

const Ratio = z.number().positive().max(10);

/**
 * The figures of one model's price row, as the student restart estimate
 * reads them (SPEC.md section 10.8). A cache read is at most the input
 * price; the surcharge is all or nothing.
 */
const PriceFigures = z.object({
	provider: PriceProvider,
	/** Matched as a substring of the model id, like the built-in table. */
	model: z.string().trim().min(1).max(200),
	/** US dollars per million input tokens. */
	inputPricePerMillion: z.number().positive().max(10_000),
	cacheReadRatio: z.number().positive().max(1),
	cacheWriteRatio: Ratio,
	/** Write ratio for a one-hour cache, where the provider offers one. */
	cacheWriteOneHourRatio: Ratio.nullable(),
	cacheTtlSeconds: z.number().int().positive().max(86_400),
	surchargeAboveTokens: z.number().int().positive().nullable(),
	surchargeFactor: z.number().gt(1).max(10).nullable(),
	sourceUrl: AiBaseUrl,
	/** The sentence or table cell the figures were read from. */
	sourceQuote: z.string().trim().min(1).max(2000),
});

const surchargeBoth = (row: z.infer<typeof PriceFigures>) =>
	(row.surchargeAboveTokens === null) === (row.surchargeFactor === null);
const surchargeRule = { message: "Give both surcharge figures or neither" };

/** What the price check model submits, and what a manual edit sends. */
export const PriceRowInput = PriceFigures.strict().refine(surchargeBoth, surchargeRule);
export type PriceRowInput = z.infer<typeof PriceRowInput>;

export const ModelPrice = PriceFigures.extend({
	checkedAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** A price row as the administrator's page sees it, with the id its edits name. */
export const AdminModelPrice = ModelPrice.extend({ id: z.string().uuid() });
export type AdminModelPrice = z.infer<typeof AdminModelPrice>;

export const PriceProposalStatus = z.enum(["pending", "accepted", "rejected"]);
export type PriceProposalStatus = z.infer<typeof PriceProposalStatus>;

/** A row a price run proposes, beside the row it would replace. */
export const PriceProposal = PriceFigures.extend({
	id: z.string().uuid(),
	runId: z.string().uuid(),
	status: PriceProposalStatus,
	current: ModelPrice.nullable(),
	decidedAt: z.string().datetime().nullable(),
	decidedBy: z.string().nullable(),
});
export type PriceProposal = z.infer<typeof PriceProposal>;

export const PriceRunTrigger = z.enum(["manual", "weekly"]);
export const PriceRunStatus = z.enum(["running", "done", "failed"]);

export const PriceRun = z.object({
	id: z.string().uuid(),
	trigger: PriceRunTrigger,
	status: PriceRunStatus,
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	errorCode: z.string().nullable(),
	proposalCount: z.number().int().nonnegative(),
});
export type PriceRun = z.infer<typeof PriceRun>;

export const PriceProposalDecision = z
	.object({ decision: z.enum(["accept", "reject"]) })
	.strict();
export type PriceProposalDecision = z.infer<typeof PriceProposalDecision>;

/** The public `GET /pricing` answer; the built-in table is the fallback. */
export const PricingTable = z.object({ prices: z.array(ModelPrice) });
export type PricingTable = z.infer<typeof PricingTable>;
