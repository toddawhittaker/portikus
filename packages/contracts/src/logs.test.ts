import { expect, test } from "vitest";
import {
	JOURNAL_CURSOR,
	LogCounts,
	LogCountsQuery,
	LogPage,
	LogQuery,
} from "./logs.js";
import { ApiErrorCode } from "./workspace.js";

const cursor =
	"s=ffb9317810ab4ca4bac4630a025ec41d;i=ae8cf;b=3152e3f1dfa549eda5a6ea57f3386b47;m=15154c18366;t=65c68898554e0;x=b7fb1885b2bc9247";

test("the default levels are error and warn", () => {
	expect(LogQuery.parse({}).level).toEqual(["error", "warn"]);
});

test("levels and services are comma lists of known names", () => {
	const query = LogQuery.parse({ level: "error,debug", service: "api,controller" });
	expect(query.level).toEqual(["error", "debug"]);
	expect(query.service).toEqual(["api", "controller"]);
	expect(LogQuery.safeParse({ level: "error,loud" }).success).toBe(false);
	expect(LogQuery.safeParse({ service: "dex" }).success).toBe(false);
	expect(LogQuery.safeParse({ level: "" }).success).toBe(false);
});

test("a journald cursor is accepted and anything else refused", () => {
	expect(JOURNAL_CURSOR.test(cursor)).toBe(true);
	expect(LogQuery.parse({ cursor }).cursor).toBe(cursor);
	for (const bad of ["", "abc", `${cursor};z=1`, `${cursor}\n`, `--since=${cursor}`]) {
		expect(LogQuery.safeParse({ cursor: bad }).success, bad).toBe(false);
	}
});

test("the text filter is at most 200 characters", () => {
	expect(LogQuery.safeParse({ q: "a".repeat(200) }).success).toBe(true);
	expect(LogQuery.safeParse({ q: "a".repeat(201) }).success).toBe(false);
});

test("unknown fields, bad ids and a reversed range are refused", () => {
	expect(LogQuery.safeParse({ unit: "sshd.service" }).success).toBe(false);
	expect(LogQuery.safeParse({ user: "bob" }).success).toBe(false);
	expect(
		LogQuery.safeParse({ since: "2026-09-26T12:00:00Z", until: "2026-09-26T11:00:00Z" })
			.success,
	).toBe(false);
});

test("pages and counts parse", () => {
	expect(
		LogPage.parse({
			lines: [
				{
					cursor,
					at: "2026-09-26T12:00:00.000Z",
					service: "api",
					line: { level: "warn", service: "api", time: "x", msg: "m" },
					userName: null,
				},
			],
			nextCursor: null,
			scanComplete: true,
			skippedLines: 0,
		}).lines,
	).toHaveLength(1);
	expect(LogCountsQuery.safeParse({ range: "2h" }).success).toBe(false);
	expect(
		LogCounts.parse({
			bucketSeconds: 60,
			from: "2026-09-26T11:00:00.000Z",
			to: "2026-09-26T12:00:00.000Z",
			buckets: [{ at: "2026-09-26T11:30:00.000Z", errors: 1, warnings: 2 }],
			complete: false,
			oldestAt: null,
		}).complete,
	).toBe(false);
});

test("LOGS_UNAVAILABLE is an API error code", () => {
	expect(ApiErrorCode.parse("LOGS_UNAVAILABLE")).toBe("LOGS_UNAVAILABLE");
});
