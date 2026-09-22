import { sql } from "kysely";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { createDb } from "./index.js";
import { createRunDatabase, dropRunDatabase, hasTestDb } from "./testing.js";

describe("createRunDatabase", () => {
	test.skipIf(!hasTestDb())(
		"migrates a fresh database and does not touch the shared one",
		async () => {
			const sharedUrl = process.env.TEST_DATABASE_URL;
			if (!sharedUrl) throw new Error("TEST_DATABASE_URL is not set");

			const created = await createRunDatabase(sharedUrl);
			expect(created.name.endsWith("_e2e")).toBe(true);
			expect(created.url).not.toBe(sharedUrl);

			const db = createDb(created.url, 1);
			try {
				const tables = await sql<{ name: string }>`
					select tablename as name from pg_tables where schemaname = 'public'
				`.execute(db);
				expect(tables.rows.map((row) => row.name)).toContain("users");
				const history = await sql<{ name: string }>`
					select name from kysely_migration
				`.execute(db);
				expect(
					history.rows.some((row) => row.name === "0010_preview_grant_session"),
				).toBe(false);
			} finally {
				await db.destroy();
				await dropRunDatabase(sharedUrl, created.name);
			}

			const client = new pg.Client({ connectionString: sharedUrl });
			await client.connect();
			try {
				const { rows } = await client.query<{ datname: string }>(
					"SELECT datname FROM pg_database WHERE datname = $1",
					[created.name],
				);
				expect(rows).toEqual([]);
			} finally {
				await client.end();
			}
		},
	);
});
