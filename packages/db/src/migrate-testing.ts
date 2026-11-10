import type { Migrator } from "kysely/migration";

/**
 * Rolls back migrations, newest first, until `name` is the latest applied
 * one, so a migration test names the step it wants to stand on instead of
 * repeating one rollback per migration above it. Each rollback must
 * succeed; a failure throws the migration's own error.
 *
 * Rejects a name the migrator does not know, and one that is not applied,
 * so a typo or a stale name fails here and not as a confusing later
 * assertion.
 */
export async function migrateDownTo(migrator: Migrator, name: string): Promise<void> {
	const known = await migrator.getMigrations();
	if (!known.some((m) => m.name === name)) {
		throw new Error(`migrateDownTo: unknown migration "${name}"`);
	}
	for (;;) {
		const applied = (await migrator.getMigrations()).filter((m) => m.executedAt);
		if (!applied.some((m) => m.name === name)) {
			throw new Error(`migrateDownTo: migration "${name}" is not applied`);
		}
		if (applied[applied.length - 1]?.name === name) {
			return;
		}
		const { error } = await migrator.migrateDown();
		if (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}
	}
}
