import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { OPERATIONS } from "../catalog/index.js";

/**
 * The fixed list of audit entries the digest counts. Counts only: no actor,
 * target or metadata value ever reaches the digest (SPEC.md section 24).
 * Each rule is one SQL condition over `audit_events` rows in the week.
 */
const RULES: readonly { label: string; where: ReturnType<typeof sql<boolean>> }[] = [
	{ label: "Denied requests", where: sql<boolean>`result = 'denied'` },
	{
		label: "Destructive operations through an API key or the assistant",
		where: sql<boolean>`action in ('api_key.used', 'assistant.used')
			and result = 'ok'
			and metadata->>'operation' in (${sql.join(destructiveOperations())})`,
	},
	{
		label: "Root shell sessions opened",
		where: sql<boolean>`action = 'admin.root_shell_opened' and result = 'ok'`,
	},
	{
		label: "Accounts linked (this acts as the other person)",
		where: sql<boolean>`action = 'user.linked' and result = 'ok'`,
	},
	{
		label: "API keys made or rotated",
		where: sql<boolean>`action in ('api_key.created', 'api_key.rotated') and result = 'ok'`,
	},
	{
		label: "Administrator or instructor roles granted",
		where: sql<boolean>`action = 'user.role_changed' and result = 'ok'
			and metadata->>'to' in ('administrator', 'instructor')`,
	},
	{
		label: "Password or second-factor resets",
		where: sql<boolean>`action in ('user.password_reset_requested', 'user.password_reset_by_email',
			'dex_user.password_reset', 'local_admin.reset', 'auth.second_factor_reset') and result = 'ok'`,
	},
];

/** Names of the catalog's destructive operations (SPEC.md section 24.8). */
function destructiveOperations() {
	return Object.values(OPERATIONS)
		.filter((operation) => operation.risk === "destructive")
		.map((operation) => operation.name);
}

/** One line per rule that matched, or one line saying nothing did. */
export async function oddAuditLines(
	db: Kysely<Database>,
	from: Date,
	to: Date,
): Promise<string[]> {
	const row = await sql<Record<string, string>>`
		select ${sql.join(
			RULES.map(
				(rule, i) => sql`count(*) filter (where ${rule.where}) as ${sql.ref(`r${i}`)}`,
			),
		)}
		from audit_events
		where at >= ${from} and at < ${to}
	`
		.execute(db)
		.then((result) => result.rows[0] ?? {});
	const lines = RULES.flatMap((rule, i) => {
		const count = Number(row[`r${i}`] ?? 0);
		return count > 0 ? [`${rule.label}: ${count}.`] : [];
	});
	return lines.length > 0 ? lines : ["Nothing odd in the audit trail."];
}
