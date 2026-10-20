import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * The administrator's site switches that the browser and the API both read:
 * voice input (SPEC.md §25.10) and code help (§13.6). Both are on until a
 * settings row says otherwise.
 */
export async function siteSwitches(
	db: Kysely<Database>,
): Promise<{ voiceInputEnabled: boolean; codeHelpEnabled: boolean }> {
	const row = await db
		.selectFrom("settings")
		.select(["voice_input_enabled", "code_help_enabled"])
		.where("id", "=", 1)
		.executeTakeFirst();
	return {
		voiceInputEnabled: row?.voice_input_enabled ?? true,
		codeHelpEnabled: row?.code_help_enabled ?? true,
	};
}
