import { type Database, recordNotification } from "@portikus/db";
import type { Kysely } from "kysely";

export type ResetKind = "password" | "second_factor";

const WHAT: Record<ResetKind | "both", string> = {
	password: "your password",
	second_factor: "your two-factor sign-in",
	both: "your password and your two-factor sign-in",
};

export const RESET_NOTICE_TITLES: Record<ResetKind | "both", string> = {
	password: "An administrator reset your password",
	second_factor: "An administrator reset your two-factor sign-in",
	both: "An administrator reset your password and two-factor sign-in",
};

/**
 * Tell the account holder an administrator reset a credential (SPEC.md
 * section 24.13). An unread notice of the other kind is folded into one
 * that names both, so a person who lost both reads one message.
 */
export async function notifyCredentialReset(
	trx: Kysely<Database>,
	userId: string,
	kind: ResetKind,
	now: Date = new Date(),
): Promise<void> {
	const other: ResetKind = kind === "password" ? "second_factor" : "password";
	const folded = await trx
		.deleteFrom("notifications")
		.where("user_id", "=", userId)
		.where("read_at", "is", null)
		.where("title", "in", [RESET_NOTICE_TITLES[other], RESET_NOTICE_TITLES.both])
		.returning("id")
		.execute();
	const which = folded.length > 0 ? "both" : kind;
	const date = now.toISOString().slice(0, 10);
	await recordNotification(trx, userId, {
		tone: "warning",
		title: RESET_NOTICE_TITLES[which],
		body: `An administrator reset ${WHAT[which]} on ${date}. If you did not ask for this, tell your instructor or the site administrator.`,
	});
}
