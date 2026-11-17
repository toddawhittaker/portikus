import { type Kysely, sql } from "kysely";

/**
 * Dollars per million output tokens on prices and proposals (SPEC.md
 * section 20.5). Empty on rows saved before the column existed; every save
 * path requires it from now on, and a row without it prices to no estimate.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	for (const table of ["model_prices", "price_proposals"]) {
		await sql`alter table ${sql.table(table)}
			add column output_price_per_million numeric
				check (output_price_per_million > 0 and output_price_per_million <= 10000)`.execute(
			db,
		);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of ["model_prices", "price_proposals"]) {
		await sql`alter table ${sql.table(table)} drop column output_price_per_million`.execute(
			db,
		);
	}
}
