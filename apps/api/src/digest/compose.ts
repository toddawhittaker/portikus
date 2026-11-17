import { MAX_NOTIFICATION_BODY_LENGTH } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { oddAuditLines } from "./audit.js";
import { capacityLines, weekHealth } from "./health.js";
import { usageLines } from "./usage.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * Join sections under their headings, cut to what a notification keeps. A cut
 * falls after a whole line; only a single line longer than the limit is cut
 * mid-line.
 */
export function fitBody(
	sections: readonly (readonly [string, readonly string[]])[],
): string {
	const text = sections
		.map(([heading, lines]) => [heading, ...lines].join("\n"))
		.join("\n\n");
	if (text.length <= MAX_NOTIFICATION_BODY_LENGTH) return text;
	const head = text.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 2);
	const lineEnd = head.lastIndexOf("\n");
	// A cut that would leave only the first heading falls through to the plain cut.
	if (lineEnd > head.indexOf("\n")) return `${head.slice(0, lineEnd)}\n…`;
	return `${text.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1)}…`;
}

/** The digest text for the seven days before `now`. Code only; no model is called. */
export async function composeDigest(db: Kysely<Database>, now: Date): Promise<string> {
	const from = new Date(now.getTime() - WEEK_MS);
	const health = await weekHealth(db, now);
	// Audit leads so that a cut to the notification limit drops the routine figures, not it.
	return fitBody([
		["Audit", await oddAuditLines(db, from, now)],
		["Health", health.lines],
		["Capacity", await capacityLines(db, health.peakRunning)],
		["Usage", await usageLines(db, now, health.starts, from)],
	]);
}
