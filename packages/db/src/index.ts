import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export { migrateToLatest } from "./migrate.js";
export type { Database, NotificationsTable } from "./schema.js";

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

/** Whether an error is the pool giving up waiting for a free connection. */
export function isPoolTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === POOL_TIMEOUT_MESSAGE;
}

/** Error codes and messages that mean PostgreSQL could not be reached. */
const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "57P01", "57P03"]);
const UNAVAILABLE_MESSAGES = [
	"Connection terminated due to connection timeout",
	"Connection terminated unexpectedly",
];

/**
 * Whether an error means no database connection could be had: the pool
 * timed out, or PostgreSQL refused, is restarting or dropped the connection.
 * Ordinary query errors return false.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (isPoolTimeout(error)) return true;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
	return UNAVAILABLE_MESSAGES.includes(error.message);
}

/**
 * Whether an error is a PostgreSQL unique violation (code 23505), and, when
 * a constraint name is given, a violation of that constraint.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, constraint: violated } = error as {
		code?: unknown;
		constraint?: unknown;
	};
	if (code !== "23505") return false;
	return constraint === undefined || violated === constraint;
}

/** One audit row; the caller keeps secrets and personal data out of `metadata`. */
export interface AuditEvent {
	actor: string;
	target: string;
	action: string;
	result: string;
	metadata?: Record<string, unknown> | null;
}

/** Write one audit row (SPEC.md section 24). Accepts the db or a transaction. */
export async function recordAudit(
	db: Kysely<Database>,
	event: AuditEvent,
): Promise<void> {
	const { actor, target, action, result, metadata } = event;
	await db
		.insertInto("audit_events")
		.values({
			actor,
			target,
			action,
			result,
			metadata: metadata == null ? null : JSON.stringify(metadata),
		})
		.execute();
}
