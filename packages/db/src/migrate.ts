import type { Kysely } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { createDb } from "./index.js";
import { migrations } from "./migrations/index.js";
import type { Database } from "./schema.js";

/**
 * Run all pending migrations to the latest version.
 * Returns the list of migration names that were executed. `list` is
 * replaceable so a test can add a late-arriving migration.
 */
export async function migrateToLatest(
	db: Kysely<Database>,
	list: Record<string, Migration> = migrations,
): Promise<string[]> {
	const migrator = new Migrator({
		db,
		provider: { getMigrations: async () => list },
		// Epic 11's 0014 may be applied before Epic 10's 0013 arrives.
		allowUnorderedMigrations: true,
	});

	const { results, error } = await migrator.migrateToLatest();

	if (error) {
		throw error;
	}

	return (results ?? [])
		.filter((r) => r.status === "Success")
		.map((r) => r.migrationName);
}

/**
 * CLI entry point: read DATABASE_URL, migrate, report, exit.
 */
async function main(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error("DATABASE_URL is not set");
		process.exit(1);
	}

	const db = createDb(url);
	try {
		const applied = await migrateToLatest(db);
		if (applied.length === 0) {
			console.log("No pending migrations.");
		} else {
			console.log(`Applied migrations: ${applied.join(", ")}`);
		}
	} finally {
		await db.destroy();
	}
}

// Run when executed directly (node dist/migrate.js).
const isMain =
	typeof process !== "undefined" &&
	process.argv[1] &&
	(process.argv[1].endsWith("/migrate.js") || process.argv[1].endsWith("/migrate.ts"));

if (isMain) {
	main().catch((err) => {
		console.error("Migration failed:", err);
		process.exit(1);
	});
}
