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

	test("a change batch and a destructive batch both ask for the row count, and show the rows", () => {
		for (const name of ["invitations.create", "egress.add_entry"]) {
			const card = batchCard("call-b", op(name), { ...batch, operation: name });
			expect(card).toMatchObject({
				type: "permission.requested",
				id: "call-b",
				toolName: "run_batch",
				title: op(name).description,
				input: { operation: name, rows: batch.rows },
				risk: op(name).risk,
				confirmText: "2",
			});
			expect(card.options.map((o) => o.decision)).toEqual(["allowed", "denied"]);
		}
	});

	test("only the exact row count approves", () => {
		expect(decide({ optionId: "approve", confirmation: "2" }, "2")).toBe("approved");
		for (const confirmation of [undefined, "", "1", "02", "2 ", "two"]) {
			expect(decide({ optionId: "approve", confirmation }, "2")).toBe("denied");
		}
	});
});
