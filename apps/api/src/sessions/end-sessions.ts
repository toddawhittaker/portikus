import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/** End every platform and preview session of an account. */
export async function endSessions(trx: Kysely<Database>, id: string): Promise<void> {
	await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
	await trx
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("user_id", "=", id)
		.where("revoked_at", "is", null)
		.execute();
}
