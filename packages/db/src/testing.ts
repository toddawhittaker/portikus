import type { Kysely } from "kysely";
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
 * Connect to the test database, run migrations, and return helpers.
 * Throws if TEST_DATABASE_URL is not set.
 */
export async function createTestDb(): Promise<TestDb> {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error("TEST_DATABASE_URL is not set. Skipping database tests.");
	}

	const db = createDb(url);
	await migrateToLatest(db);

	const truncate = async () => {
		await db.deleteFrom("workspace_connections").execute();
		await db.deleteFrom("audit_events").execute();
		await db.deleteFrom("workspaces").execute();
	};

	const close = async () => {
		await db.destroy();
	};

	return { db, truncate, close };
}
