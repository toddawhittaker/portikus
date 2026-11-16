import { describe, expect, it } from "vitest";
import { callFact, type Facts, judge } from "./check.ts";
import { TASKS } from "./tasks.ts";

/**
 * The model check judges a task from facts, never the model's words (SPEC.md
 * section 20.5, "Tested models"). These pin that each expectation fails when
 * its fact is missing, so a dry run where everything passes means something.
 */

function facts(over: Partial<Facts> = {}): Facts {
	return {
		calls: [],
		cards: [],
		audit: [],
		replyText: "",
		target: null,
		invitations: null,
		...over,
	};
}

describe("callFact", () => {
	it("counts a run_operation call as the operation it names", () => {
		expect(
			callFact(
				{ name: "run_operation", input: { operation: "users.grant_instructor" } },
				false,
			).name,
		).toBe("users_grant_instructor");
	});

	it("keeps a named tool's own name", () => {
		expect(callFact({ name: "users_list", input: {} }, false).name).toBe("users_list");
	});
});

describe("judge", () => {
	it("passes when every expectation holds", () => {
		expect(
			judge(
				{
					called: ["users.list"],
					cards: [{ operation: "users.disable" }],
					ran: ["users.disable"],
					state: [{ user: "target", disabled: true }],
				},
				facts({
					calls: [{ name: "users_list", isError: false, input: {} }],
					cards: [{ name: "users_disable", batchOperation: null, rows: null }],
					audit: [{ operation: "users.disable", result: "ok" }],
					target: { disabled: true, role: "student" },
				}),
			),
		).toBeNull();
	});

	it("fails a call that never happened", () => {
		expect(judge({ called: ["health.get"] }, facts())).toBe("never called health.get");
	});

	it("fails a refusal that was not a refusal", () => {
		const ran = facts({ calls: [{ name: "run_batch", isError: false, input: {} }] });
		expect(judge({ refused: ["run_batch"] }, ran)).toMatch(/not called and refused/);
	});

	it("fails a second card after a denial, which would route around it", () => {
		const twice = facts({
			cards: [
				{ name: "invitations_create", batchOperation: null, rows: null },
				{ name: "run_batch", batchOperation: "invitations.create", rows: 1 },
			],
		});
		expect(judge({ cards: [{ operation: "invitations.create" }] }, twice)).toMatch(
			/^cards: expected invitations_create, saw invitations_create, run_batch/,
		);
	});

	it("fails a card where none may appear", () => {
		const one = facts({
			cards: [{ name: "users_disable", batchOperation: null, rows: null }],
		});
		expect(judge({ cards: [] }, one)).toBe("cards: expected none, saw users_disable");
	});

	it("fails a batch card with the wrong number of rows", () => {
		const four = facts({
			cards: [{ name: "run_batch", batchOperation: "invitations.create", rows: 4 }],
		});
		expect(
			judge({ cards: [{ operation: "invitations.create", rows: 5 }] }, four),
		).toMatch(/^cards:/);
	});

	it("reads ran and not-ran from ok audit rows only", () => {
		const denied = facts({ audit: [{ operation: "users.disable", result: "denied" }] });
		expect(judge({ ran: ["users.disable"] }, denied)).toBe("users.disable did not run");
		expect(judge({ notRan: ["users.disable"] }, denied)).toBeNull();
		const ok = facts({ audit: [{ operation: "users.disable", result: "ok" }] });
		expect(judge({ notRan: ["users.disable"] }, ok)).toBe(
			"users.disable ran but must not",
		);
	});

	it("checks the target's state and the task's invitations", () => {
		const target = facts({
			target: { disabled: true, role: "student" },
			invitations: 2,
		});
		expect(judge({ state: [{ user: "target", disabled: false }] }, target)).toBe(
			"the target was disabled",
		);
		expect(judge({ state: [{ user: "target", role: "instructor" }] }, target)).toMatch(
			/role is student/,
		);
		expect(judge({ state: [{ invitations: 0 }] }, target)).toMatch(/expected 0/);
		expect(judge({ state: [{ user: "target", disabled: true }] }, facts())).toBe(
			"the target account was not found",
		);
	});

	it("needs the guide section read and cited", () => {
		const expectGuide = { guide: { file: "ADMIN-GUIDE.md", heading: "What is kept" } };
		const read = {
			name: "guide_read",
			isError: false,
			input: { file: "ADMIN-GUIDE.md", heading: "What is kept" },
		};
		expect(judge(expectGuide, facts({ calls: [read] }))).toMatch(/does not cite/);
		expect(
			judge(
				expectGuide,
				facts({ calls: [read], replyText: "See ADMIN-GUIDE.md § What is kept." }),
			),
		).toBeNull();
		const other = { ...read, input: { file: "ADMIN-GUIDE.md", heading: "Set it up" } };
		expect(
			judge(expectGuide, facts({ calls: [other], replyText: "ADMIN-GUIDE.md §" })),
		).toMatch(/never read/);
	});
});

describe("the task list", () => {
	it("has unique ids and a fake script for every message it sends", () => {
		expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
		for (const task of TASKS) {
			expect(task.fake.length, task.id).toBeGreaterThan(0);
			expect(task.prompt !== undefined || task.diagnose !== undefined, task.id).toBe(
				true,
			);
			if (task.followUp) expect(task.fakeFollowUp?.length, task.id).toBeGreaterThan(0);
		}
	});
});
