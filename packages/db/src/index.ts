import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export { migrateToLatest } from "./migrate.js";
export type { Database } from "./schema.js";

/**
 * Create a Kysely instance connected to PostgreSQL at the given URL.
 * `maxConnections` caps the pool; the tests set it low because many test
 * files hold a pool at the same time against one PostgreSQL server.
 */
export function createDb(url: string, maxConnections?: number): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: new pg.Pool({ connectionString: url, max: maxConnections }),
		}),
	});
}
