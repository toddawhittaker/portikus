import { CODE_HELP_LANGUAGE_IDS, type CodeHelpLanguage } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * The stored language ids that code help knows, in the contract's order. An
 * id this build does not ship is dropped, so a stale row cannot turn on a
 * server that does not exist (SPEC.md §13.6).
 */
export function knownCodeHelpLanguages(stored: readonly string[]): CodeHelpLanguage[] {
	return CODE_HELP_LANGUAGE_IDS.filter((id) => stored.includes(id));
}

/**
 * The administrator's site switches that the browser and the API both read:
 * voice input (SPEC.md §25.10) and the languages code help is on for (§13.6).
 * Voice input is on until a settings row says otherwise. With no settings row
 * code help is on for every language, as a new row would be.
 */
export async function siteSwitches(db: Kysely<Database>): Promise<{
	voiceInputEnabled: boolean;
	codeHelpLanguages: CodeHelpLanguage[];
}> {
	const row = await db
		.selectFrom("settings")
		.select(["voice_input_enabled", "code_help_languages"])
		.where("id", "=", 1)
		.executeTakeFirst();
	return {
		voiceInputEnabled: row?.voice_input_enabled ?? true,
		codeHelpLanguages: row
			? knownCodeHelpLanguages(row.code_help_languages)
			: [...CODE_HELP_LANGUAGE_IDS],
	};
}
