import { type Database, recordNotification } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Tell the SSO account's holder an administrator linked or unlinked a course
 * account, so the change is never silent (SPEC.md section 24.11). The notice
 * is kept: the account can mark it read but not delete it.
 */
export async function notifyLinkChange(
	trx: Kysely<Database>,
	userId: string,
	change: "linked" | "unlinked",
	course: { displayName: string; platformName: string },
): Promise<void> {
	const linked = change === "linked";
	await recordNotification(
		trx,
		userId,
		{
			tone: "warning",
			title: linked
				? "An administrator linked a course account to yours"
				: "An administrator unlinked a course account from yours",
			body: `${course.displayName} from ${course.platformName} is ${linked ? "now" : "no longer"} linked to your account. If you did not expect this, tell your instructor or the site administrator.`,
		},
		{ kept: true },
	);
}
