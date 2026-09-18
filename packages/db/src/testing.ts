import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { expect } from "vitest";
import { createDb } from "./index.js";
import { migrateToLatest } from "./migrate.js";
import type { Database } from "./schema.js";

/**
 * Returns true when TEST_DATABASE_URL is set and a test database is
 * available. Use with `test.skipIf(!hasTestDb())`.
 */
export function hasTestDb(): boolean {
	return !!process.env.TEST_DATABASE_URL;
}

export interface TestDb {
	db: Kysely<Database>;
	/** Delete all rows from every application table. */
	truncate: () => Promise<void>;
	/** Destroy the connection pool. Call in afterAll. */
	close: () => Promise<void>;
}

/**
 * Every test file gets its own database, so the files can run in parallel.
 * The name carries the process id and a hash of the test file path: the pid
 * keeps two whole-suite runs on one machine apart, the hash keeps the files
 * of one run apart and says which file a leftover database came from.
 * PostgreSQL identifiers stop at 63 characters, hence the trimmed base.
 */
function perFileDbName(url: URL, testPath: string): string {
	const base = url.pathname
		.slice(1)
		.replace(/[^A-Za-z0-9_]/g, "_")
		.slice(0, 30);
	const hash = createHash("sha256").update(testPath).digest("hex").slice(0, 8);
	return `${base}_p${process.pid}_${hash}`;
}

/**
 * Pools per test file times test files must stay under the server's
 * max_connections (100 by default), so keep each file's pool small.
 */
const TEST_POOL_SIZE = 4;

/**
 * Create a database of this test file's own, run migrations, and return
 * helpers. Throws if TEST_DATABASE_URL is not set.
 *
 * While the file runs, TEST_DATABASE_URL points at that private database,
 * so code that reads it (the API test config) sees the same one. `close`
 * restores it and drops the database.
 */
export async function createTestDb(): Promise<TestDb> {
	const sharedUrl = process.env.TEST_DATABASE_URL;
	if (!sharedUrl) {
		throw new Error("TEST_DATABASE_URL is not set. Skipping database tests.");
	}

	const url = new URL(sharedUrl);
	const name = perFileDbName(url, expect.getState().testPath ?? "unknown");
	// A crashed earlier run with the same pid could have left this behind.
	await runOnServer(sharedUrl, [
		`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
		`CREATE DATABASE "${name}"`,
	]);

	url.pathname = `/${name}`;
	const ownUrl = url.toString();
	process.env.TEST_DATABASE_URL = ownUrl;

	const db = createDb(ownUrl, TEST_POOL_SIZE);
	await migrateToLatest(db);

	const truncate = async () => {
		await db.deleteFrom("terminals").execute();
		await db.deleteFrom("projects").execute();
		await db.deleteFrom("workspace_connections").execute();
		await db.deleteFrom("audit_events").execute();
		await db.deleteFrom("workspaces").execute();
		await db.deleteFrom("settings").execute();
		await db.deleteFrom("sessions").execute();
		await db.deleteFrom("users").execute();
	};

	const close = async () => {
		await db.destroy();
		process.env.TEST_DATABASE_URL = sharedUrl;
		await runOnServer(sharedUrl, [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
	};

	return { db, truncate, close };
}

/** Run statements on the shared database, used to create and drop databases. */
async function runOnServer(url: string, statements: string[]): Promise<void> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		for (const statement of statements) {
			await client.query(statement);
		}
	} finally {
		await client.end();
	}
}

export interface TestUserOverrides {
	oidc_issuer?: string;
	oidc_subject?: string;
	email?: string | null;
	display_name?: string;
	role?: string;
	disabled_at?: string | null;
	shutdown_grace_seconds?: number | null;
}

/** Insert a user row and return its id. */
export async function insertTestUser(
	db: Kysely<Database>,
	overrides: TestUserOverrides = {},
): Promise<string> {
	const row = await db
		.insertInto("users")
		.values({
			oidc_issuer: "https://test.invalid",
			oidc_subject: `subject-${Math.random().toString(36).slice(2, 12)}`,
			display_name: "Test User",
			role: "student",
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}
