import { z } from "zod";
import { LogLevel } from "./settings.js";

/** The platform services whose journal the Logs tab reads (docs/adr/0036). */
export const LOG_SERVICES = ["api", "worker", "controller"] as const;
export const LogService = z.enum(LOG_SERVICES);
export type LogService = z.infer<typeof LogService>;

/** Lines per page of `GET /admin/logs`. */
export const LOG_PAGE_SIZE = 100;

/** The longest text filter the API accepts. */
export const LOG_TEXT_MAX = 200;

/** journald's cursor syntax; anything else is refused before it reaches journalctl. */
export const JOURNAL_CURSOR =
	/^s=[0-9a-f]{32};i=[0-9a-f]+;b=[0-9a-f]{32};m=[0-9a-f]+;t=[0-9a-f]+;x=[0-9a-f]+$/;

/** A comma-separated list in the query string, each item checked by `item`. */
function commaList<T extends z.ZodType<unknown, string>>(item: T) {
	return z
		.string()
		.transform((value) => value.split(",").filter((part) => part !== ""))
		.pipe(z.array(item).min(1));
}

/** Query string of `GET /admin/logs`. Error and Warn are the default levels. */
export const LogQuery = z
	.object({
		level: commaList(LogLevel).default(["error", "warn"]),
		/** Absent means every service. */
		service: commaList(LogService).optional(),
		since: z.string().datetime().optional(),
		until: z.string().datetime().optional(),
		q: z.string().min(1).max(LOG_TEXT_MAX).optional(),
		user: z.string().uuid().optional(),
		workspace: z.string().uuid().optional(),
		/** Continue below this entry; the `nextCursor` of the previous page. */
		cursor: z.string().regex(JOURNAL_CURSOR).optional(),
	})
	.strict()
	.refine((query) => !query.since || !query.until || query.since <= query.until, {
		message: "since must not be after until",
		path: ["since"],
	});
export type LogQuery = z.infer<typeof LogQuery>;

/** One Portikus log line, redacted on the server. */
export const LogLine = z.object({
	cursor: z.string().regex(JOURNAL_CURSOR),
	/** The journal's timestamp for the entry. */
	at: z.string().datetime(),
	/** From the unit the entry came from, not from the line. */
	service: LogService,
	/** The parsed MESSAGE after redaction; it has string `level`, `service` and `time`. */
	line: z.record(z.string(), z.unknown()),
	/** Display name for the line's `userId`, when it names a known user. */
	userName: z.string().nullable(),
});
export type LogLine = z.infer<typeof LogLine>;

export const LogPage = z.object({
	lines: z.array(LogLine),
	/** Pass as `cursor` for older lines; null when the journal has none left to read. */
	nextCursor: z.string().regex(JOURNAL_CURSOR).nullable(),
	/** False when the scan stopped at its entry or time limit before filling the page. */
	scanComplete: z.boolean(),
	/** Entries read that were not Portikus JSON lines, such as systemd's own. */
	skippedLines: z.number().int().nonnegative(),
});
export type LogPage = z.infer<typeof LogPage>;

/** The Health tab's ranges; the same four as the series route. */
export const LogCountsQuery = z
	.object({ range: z.enum(["1h", "6h", "1d", "7d"]) })
	.strict();
export type LogCountsQuery = z.infer<typeof LogCountsQuery>;

/** Error (with fatal) and warn lines per bucket; empty buckets are absent. */
export const LogCounts = z.object({
	bucketSeconds: z.number().int().positive(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	buckets: z.array(
		z.object({
			at: z.string().datetime(),
			errors: z.number().int().nonnegative(),
			warnings: z.number().int().nonnegative(),
		}),
	),
	/** False until the API has read the whole window since it started. */
	complete: z.boolean(),
	/** The oldest entry the journal still holds for the three units. */
	oldestAt: z.string().datetime().nullable(),
});
export type LogCounts = z.infer<typeof LogCounts>;
