import { z } from "zod";
import { AiBaseUrl, type AiUsageCounts } from "./ai.js";

/** Whose API price list a row comes from; prices are API prices only. */
export const PriceProvider = z.enum(["anthropic", "openai"]);
export type PriceProvider = z.infer<typeof PriceProvider>;

/** Read when the AI settings list no pricing sources: the providers' own API price pages. */
export const DEFAULT_PRICE_SOURCES: readonly string[] = [
	"https://developers.openai.com/api/docs/pricing",
	"https://platform.claude.com/docs/en/about-claude/pricing",
];

const Ratio = z.number().positive().max(10);
const OutputPrice = z.number().positive().max(10_000);

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
	/** US dollars per million output tokens; null on rows saved before it was asked for. */
	outputPricePerMillion: OutputPrice.nullable().optional(),
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

const surchargeBoth = (row: {
	surchargeAboveTokens: number | null;
	surchargeFactor: number | null;
}) => (row.surchargeAboveTokens === null) === (row.surchargeFactor === null);
const surchargeRule = { message: "Give both surcharge figures or neither" };

/** What the price check model submits, and what a manual edit sends. */
export const PriceRowInput = PriceFigures.extend({
	outputPricePerMillion: OutputPrice,
})
	.strict()
	.refine(surchargeBoth, surchargeRule);
export type PriceRowInput = z.infer<typeof PriceRowInput>;

/**
 * The model name as the table stores it (SPEC.md section 20.5). Anthropic
 * rows use the API id, so "Claude Opus 5.5" becomes "claude-opus-5-5";
 * OpenAI names are only lowercased and trimmed.
 */
export function normalizePriceModel(provider: PriceProvider, model: string): string {
	const name = model.trim().toLowerCase();
	return provider === "anthropic" ? name.replace(/[ .]+/g, "-") : name;
}

/** The row with its model name normalised; every path that stores a row goes through it. */
export function normalizePriceRow(row: PriceRowInput): PriceRowInput {
	return { ...row, model: normalizePriceModel(row.provider, row.model) };
}

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

/** Accepting a proposal saved before output prices existed needs one in the same request. */
export const PriceProposalDecision = z
	.object({
		decision: z.enum(["accept", "reject"]),
		outputPricePerMillion: OutputPrice.optional(),
	})
	.strict();
export type PriceProposalDecision = z.infer<typeof PriceProposalDecision>;

/** The public `GET /pricing` answer; the built-in table is the fallback. */
export const PricingTable = z.object({ prices: z.array(ModelPrice) });
export type PricingTable = z.infer<typeof PricingTable>;

/** The figures `usageDollars` reads from a price row. */
export type PriceRowFigures = Pick<
	ModelPrice,
	| "model"
	| "inputPricePerMillion"
	| "outputPricePerMillion"
	| "cacheReadRatio"
	| "cacheWriteRatio"
>;

/**
 * The row whose model name equals `model` once both are normalised for the
 * row's provider (SPEC.md section 20.5); undefined when none does.
 */
export function priceRowFor<T extends { provider: PriceProvider; model: string }>(
	model: string,
	rows: readonly T[],
): T | undefined {
	return rows.find(
		(row) =>
			normalizePriceModel(row.provider, row.model) ===
			normalizePriceModel(row.provider, model),
	);
}

/**
 * Estimated US dollars for token counts at a row's prices, or null when the
 * row has no output price. The counted input tokens already include cache
 * reads and writes, so those are taken out before the input price applies.
 * Cache writes use the default-lifetime ratio; surcharges are left out.
 */
export function usageDollars(
	counts: AiUsageCounts,
	row: PriceRowFigures,
): number | null {
	if (row.outputPricePerMillion == null) return null;
	const uncached = Math.max(
		0,
		counts.inputTokens - counts.cacheReadTokens - counts.cacheWriteTokens,
	);
	const input = row.inputPricePerMillion;
	const total =
		uncached * input +
		counts.cacheReadTokens * input * row.cacheReadRatio +
		counts.cacheWriteTokens * input * row.cacheWriteRatio +
		counts.outputTokens * row.outputPricePerMillion;
	return total / 1_000_000;
}
