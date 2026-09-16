import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export { migrateToLatest } from "./migrate.js";
export type { Database } from "./schema.js";

/**
 * Create a Kysely instance connected to PostgreSQL at the given URL.
 */
export function createDb(url: string): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: new pg.Pool({ connectionString: url }),
		}),
	});
}
