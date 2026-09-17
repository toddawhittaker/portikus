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
	};

	return { db, truncate, close };
}

export interface TestUserOverrides {
	oidc_issuer?: string;
	oidc_subject?: string;
	email?: string | null;
	display_name?: string;
	role?: string;
	disabled_at?: string | null;
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
