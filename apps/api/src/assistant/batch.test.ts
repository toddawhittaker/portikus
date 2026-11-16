import { describe, expect, test } from "vitest";
import type { RunResult } from "../catalog/run.js";
import { allOk, checkRows, resultsText, runRows } from "./batch.js";

/** A batch is checked whole before anything runs, then runs one row at a time (SPEC.md section 20.4). */

const ok = (status = 200): RunResult => ({ ok: true, status, body: "{}" });
const refusedBy = (status: number, code: string): RunResult => ({
	ok: true,
	status,
	body: JSON.stringify({ code, message: "x" }),
});

describe("checking the rows", () => {
	const check = (raw: unknown) =>
		raw === "bad" ? { problem: "nope." } : { input: { body: raw } };

	test("every row valid gives each checked input in order", () => {
		expect(checkRows(["a", "b"], check)).toEqual({
			inputs: [{ body: "a" }, { body: "b" }],
		});
	});

	test("any bad row fails the whole call and names each bad row from 1", () => {
		expect(checkRows(["a", "bad", "c", "bad"], check)).toEqual({
			problem: "Nothing ran. 2 rows are not valid: row 2: nope. row 4: nope.",
		});
		expect(checkRows(["bad"], check)).toEqual({
			problem: "Nothing ran. One row is not valid: row 1: nope.",
		});
	});
});

describe("running the rows", () => {
	test("rows run one at a time in order, and a refused or failed row does not stop the rest", async () => {
		const seen: unknown[] = [];
		let running = 0;
		const replies = [
			ok(),
			refusedBy(409, "CONFLICT"),
			refusedBy(502, "UPSTREAM"),
			ok(204),
		];
		const results = await runRows(
			[{ body: 1 }, { body: 2 }, { body: 3 }, { body: 4 }],
			async (input) => {
				running++;
				expect(running).toBe(1);
				seen.push(input.body);
				await Promise.resolve();
				running--;
				return replies[seen.length - 1] as RunResult;
			},
		);
		expect(seen).toEqual([1, 2, 3, 4]);
		expect(results).toEqual([
			{ row: 1, status: "ok", code: null },
			{ row: 2, status: "refused", code: "CONFLICT" },
			{ row: 3, status: "failed", code: "UPSTREAM" },
			{ row: 4, status: "ok", code: null },
		]);
		expect(allOk(results)).toBe(false);
	});

	test("an error body without a code reads as INTERNAL, and a runner refusal carries its own code", async () => {
		const replies: RunResult[] = [
			{ ok: true, status: 500, body: "<html>" },
			{ ok: true, status: 400, body: JSON.stringify({ code: 7 }) },
			{ ok: false, error: { code: "VALIDATION_FAILED", message: "x" } },
		];
		const results = await runRows(
			[{}, {}, {}],
			async () => replies.shift() as RunResult,
		);
		expect(results).toEqual([
			{ row: 1, status: "failed", code: "INTERNAL" },
			{ row: 2, status: "refused", code: "INTERNAL" },
			{ row: 3, status: "refused", code: "VALIDATION_FAILED" },
		]);
	});

	test("when the session ends (401) no later row runs", async () => {
		let calls = 0;
		const results = await runRows([{}, {}, {}, {}], async () => {
			calls++;
			return calls === 2 ? refusedBy(401, "UNAUTHENTICATED") : ok();
		});
		expect(calls).toBe(2);
		expect(results).toEqual([
			{ row: 1, status: "ok", code: null },
			{ row: 2, status: "refused", code: "UNAUTHENTICATED" },
			{ row: 3, status: "not run", code: "SESSION_ENDED" },
			{ row: 4, status: "not run", code: "SESSION_ENDED" },
		]);
	});

	test("the table the model reads counts the rows and names each status and code", () => {
		const results = [
			{ row: 1, status: "ok", code: null },
			{ row: 2, status: "refused", code: "CONFLICT" },
		] as const;
		expect(JSON.parse(resultsText("invitations.create", results))).toEqual({
			operation: "invitations.create",
			rows: 2,
			ok: 1,
			results,
		});
		expect(allOk([results[0]])).toBe(true);
	});
});
