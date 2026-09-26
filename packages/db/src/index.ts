import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export { migrateToLatest } from "./migrate.js";
export type { Database, NotificationsTable } from "./schema.js";

/**
 * Create a Kysely instance connected to PostgreSQL at the given URL.
 * `maxConnections` caps the pool; the tests set it low because many test
 * files hold a pool at the same time against one PostgreSQL server.
 */
export function createDb(url: string, maxConnections?: number): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: new pg.Pool(poolOptions(url, maxConnections)),
		}),
	});
}

/** The message pg-pool gives when no connection frees up in time. */
export const POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/**
 * Pool settings for every process: wait at most 5 s for a connection, end a
 * statement after 30 s and an idle transaction after 60 s, so one stuck
 * query cannot hold the pool (docs/EPIC-17.md ruling 14).
 */
export function poolOptions(url: string, maxConnections?: number): pg.PoolConfig {
	return {
		connectionString: url,
		max: maxConnections,
		connectionTimeoutMillis: 5000,
		statement_timeout: 30_000,
		idle_in_transaction_session_timeout: 60_000,
	};
}

/** Whether an error is the pool giving up waiting for a free connection. */
export function isPoolTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === POOL_TIMEOUT_MESSAGE;
}
