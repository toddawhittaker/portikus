import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

/**
 * Create a Kysely instance connected to PostgreSQL at the given URL.
 * `maxConnections` caps the pool; the tests set it low because many test
 * files hold a pool at the same time against one PostgreSQL server.
 * `onPoolError` hears about idle connections that die, for example when
 * PostgreSQL restarts; without a listener that error would end the process.
 */
export function createDb(
	url: string,
	maxConnections?: number,
	onPoolError?: (error: Error) => void,
): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: createPool(url, maxConnections, onPoolError),
		}),
	});
}

/** The pg pool behind `createDb`, with its idle-error listener attached. */
export function createPool(
	url: string,
	maxConnections?: number,
	onPoolError: (error: Error) => void = (error) =>
		console.warn(`database connection lost: ${error.message}`),
): pg.Pool {
	const pool = new pg.Pool(poolOptions(url, maxConnections));
	pool.on("error", onPoolError);
	// A checked-out client has no pool listener; its query already rejects
	// with the error, so this only keeps the "error" event from ending the process.
	pool.on("connect", (client) => client.on("error", () => {}));
	return pool;
}

/** The message pg-pool gives when no connection frees up in time. */
export const POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/**
 * Pool settings for every process: wait at most 5 s for a connection, end a
 * statement after 30 s and an idle transaction after 60 s, so one stuck
 * query cannot hold the pool (ADR 0034).
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
