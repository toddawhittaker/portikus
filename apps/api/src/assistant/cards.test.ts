import { describe, expect, test } from "vitest";
import { operationByName } from "../catalog/index.js";
import { approvalCard, batchCard, decide } from "./cards.js";

/** Cards come from the catalog and the inputs, and Approve or Deny only (SPEC.md section 20.4). */

function op(name: string) {
	const found = operationByName(name);
	if (!found || found.operation.risk === "read") throw new Error(name);
	return found.operation as typeof found.operation & { risk: "change" | "destructive" };
}

describe("approval cards", () => {
	test("a destructive card asks for the operation's name; a change card asks for nothing", () => {
		const input = { path: { id: "u-1" } };
		const destructive = approvalCard("call-1", op("users.disable"), input);
		expect(destructive).toMatchObject({
			type: "permission.requested",
			id: "call-1",
			toolName: "users_disable",
			title: op("users.disable").description,
			input,
			risk: "destructive",
			confirmText: "users.disable",
		});
		expect(destructive.options.map((o) => o.decision)).toEqual(["allowed", "denied"]);
		const change = approvalCard("call-2", op("workspaces.restart"), input);
		expect(change.risk).toBe("change");
		expect(change).not.toHaveProperty("confirmText");
	});

	test("only an exact confirmation approves a destructive call", () => {
		expect(
			decide({ optionId: "approve", confirmation: "users.disable" }, "users.disable"),
		).toBe("approved");
		for (const confirmation of [
			undefined,
			"",
			"users.disabl",
			"USERS.DISABLE",
			" users.disable",
		]) {
			expect(decide({ optionId: "approve", confirmation }, "users.disable")).toBe(
				"denied",
			);
		}
		expect(
			decide({ optionId: "deny", confirmation: "users.disable" }, "users.disable"),
		).toBe("denied");
		expect(decide({ optionId: "approve" }, null)).toBe("approved");
		expect(decide({ optionId: "allowAlways" }, null)).toBe("denied");
	});
});

describe("batch cards", () => {
	const batch = {
		operation: "invitations.create",
		rows: [{ body: { email: "a@example.edu" } }, { body: { email: "b@example.edu" } }],
	};

	test("a change batch asks for the row count, a destructive one for its name; both show the rows", () => {
		for (const [name, confirmText] of [
			["invitations.create", "2"],
			["users.disable", "users.disable"],
		] as const) {
			const card = batchCard("call-b", op(name), { ...batch, operation: name });
			expect(card).toMatchObject({
				type: "permission.requested",
				id: "call-b",
				toolName: "run_batch",
				title: op(name).description,
				input: { operation: name, rows: batch.rows },
				risk: op(name).risk,
				confirmText,
			});
			expect(card.options.map((o) => o.decision)).toEqual(["allowed", "denied"]);
		}
	});

	test("a one-row destructive batch is not approved by typing 1", () => {
		const card = batchCard("call-c", op("users.disable"), {
			operation: "users.disable",
			rows: [{ params: { id: "u1" } }],
		});
		expect(card.confirmText).toBe("users.disable");
		expect(
			decide({ optionId: "approve", confirmation: "1" }, card.confirmText ?? null),
		).toBe("denied");
	});

	test("only the exact row count approves", () => {
		expect(decide({ optionId: "approve", confirmation: "2" }, "2")).toBe("approved");
		for (const confirmation of [undefined, "", "1", "02", "2 ", "two"]) {
			expect(decide({ optionId: "approve", confirmation }, "2")).toBe("denied");
		}
	});
});
