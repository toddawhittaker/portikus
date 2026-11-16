import type {
	AdminModelPrice,
	ModelPrice,
	PriceProposal,
	PriceRowInput,
	PriceRun,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely, Selectable } from "kysely";

type PriceColumns = Pick<
	Selectable<Database["model_prices"]>,
	| "provider"
	| "model"
	| "input_price_per_million"
	| "cache_read_ratio"
	| "cache_write_ratio"
	| "cache_write_one_hour_ratio"
	| "cache_ttl_seconds"
	| "surcharge_above_tokens"
	| "surcharge_factor"
	| "source_url"
	| "source_quote"
>;

const num = (v: string | null) => (v === null ? null : Number(v));

function rowFigures(row: PriceColumns): PriceRowInput {
	return {
		provider: row.provider,
		model: row.model,
		inputPricePerMillion: Number(row.input_price_per_million),
		cacheReadRatio: Number(row.cache_read_ratio),
		cacheWriteRatio: Number(row.cache_write_ratio),
		cacheWriteOneHourRatio: num(row.cache_write_one_hour_ratio),
		cacheTtlSeconds: row.cache_ttl_seconds,
		surchargeAboveTokens: row.surcharge_above_tokens,
		surchargeFactor: num(row.surcharge_factor),
		sourceUrl: row.source_url,
		sourceQuote: row.source_quote,
	};
}

export function figureColumns(row: PriceRowInput) {
	return {
		provider: row.provider,
		model: row.model,
		input_price_per_million: row.inputPricePerMillion,
		cache_read_ratio: row.cacheReadRatio,
		cache_write_ratio: row.cacheWriteRatio,
		cache_write_one_hour_ratio: row.cacheWriteOneHourRatio,
		cache_ttl_seconds: row.cacheTtlSeconds,
		surcharge_above_tokens: row.surchargeAboveTokens,
		surcharge_factor: row.surchargeFactor,
		source_url: row.sourceUrl,
		source_quote: row.sourceQuote,
	};
}

/** Whether two rows charge the same; the address and quote do not count. */
export function sameFigures(a: PriceRowInput, b: PriceRowInput): boolean {
	return (
		a.inputPricePerMillion === b.inputPricePerMillion &&
		a.cacheReadRatio === b.cacheReadRatio &&
		a.cacheWriteRatio === b.cacheWriteRatio &&
		a.cacheWriteOneHourRatio === b.cacheWriteOneHourRatio &&
		a.cacheTtlSeconds === b.cacheTtlSeconds &&
		a.surchargeAboveTokens === b.surchargeAboveTokens &&
		a.surchargeFactor === b.surchargeFactor
	);
}

function modelPrice(row: Selectable<Database["model_prices"]>): AdminModelPrice {
	return {
		id: row.id,
		...rowFigures(row),
		checkedAt: row.checked_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

export async function listPrices(db: Kysely<Database>): Promise<AdminModelPrice[]> {
	const rows = await db
		.selectFrom("model_prices")
		.selectAll()
		.orderBy("provider")
		.orderBy("model")
		.execute();
	return rows.map(modelPrice);
}

export async function latestRun(db: Kysely<Database>): Promise<PriceRun | null> {
	const row = await db
		.selectFrom("price_runs as r")
		.select((eb) => [
			"r.id",
			"r.trigger",
			"r.status",
			"r.started_at",
			"r.finished_at",
			"r.error_code",
			eb
				.selectFrom("price_proposals as p")
				.whereRef("p.run_id", "=", "r.id")
				.select(eb.fn.countAll<string>().as("n"))
				.as("proposals"),
		])
		.orderBy("r.started_at", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	return {
		id: row.id,
		trigger: row.trigger,
		status: row.status,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		errorCode: row.error_code,
		proposalCount: Number(row.proposals ?? 0),
	};
}

export async function pendingProposals(db: Kysely<Database>): Promise<PriceProposal[]> {
	const [rows, prices] = await Promise.all([
		db
			.selectFrom("price_proposals")
			.selectAll()
			.where("status", "=", "pending")
			.orderBy("provider")
			.orderBy("model")
			.execute(),
		listPrices(db),
	]);
	return rows.map((row) => {
		const current = prices.find(
			(p) => p.provider === row.provider && p.model === row.model,
		);
		return {
			id: row.id,
			runId: row.run_id,
			status: row.status,
			...rowFigures(row),
			current: current ? withoutId(current) : null,
			decidedAt: row.decided_at?.toISOString() ?? null,
			decidedBy: row.decided_by,
		};
	});
}

export function withoutId({ id: _id, ...price }: AdminModelPrice): ModelPrice {
	return price;
}
