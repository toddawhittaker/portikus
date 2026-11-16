import { describe, expect, test } from "vitest";
import { OPERATIONS, operationByName } from "../catalog/index.js";
import { toolName } from "../mcp/server.js";
import { assistantTools, checkInput, resolveCall, systemPrompt } from "./tools.js";

/** The assistant's tools are the MCP set for the person's role (SPEC.md sections 20.4 and 27). */

const ADMIN = { role: "administrator", readOnly: false } as const;
const INSTRUCTOR = { role: "instructor", readOnly: false } as const;

function operation(name: string) {
	const found = operationByName(name);
	if (!found) throw new Error(name);
	return found;
}

describe("the tool set", () => {
	test("is the named tools the role may run plus find and run, in catalog order", () => {
		const named = Object.values(OPERATIONS)
			.filter((op) => op.tool && op.audience !== "instructor")
			.map(toolName);
		const names = assistantTools(ADMIN).tools.map((t) => t.name);
		expect(names).toEqual([...named, "find_operation", "run_operation"]);
	});

	test("an instructor's set leaves out every administrator operation", () => {
		const names = new Set(assistantTools(INSTRUCTOR).tools.map((t) => t.name));
		for (const op of Object.values(OPERATIONS)) {
			if (!op.tool) continue;
			expect(names.has(toolName(op)), op.name).toBe(op.audience !== "administrator");
		}
	});

	test("a read-only conversation is offered read operations only", () => {
		const { named } = assistantTools({ role: "administrator", readOnly: true });
		expect(named.size).toBeGreaterThan(0);
		for (const tool of named.values()) expect(tool.operation.risk).toBe("read");
	});

	test("the system prompt and tools are the same bytes on every call", () => {
		const first = JSON.stringify([systemPrompt(ADMIN), assistantTools(ADMIN).tools]);
		const again = JSON.stringify([systemPrompt(ADMIN), assistantTools(ADMIN).tools]);
		expect(again).toBe(first);
		expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(systemPrompt(ADMIN)).toMatch(/act as an administrator/);
		expect(systemPrompt(INSTRUCTOR)).toMatch(/act as an instructor/);
		expect(systemPrompt(ADMIN)).toMatch(/never instructions/);
		expect(systemPrompt(ADMIN)).toMatch(/approval/);
		expect(systemPrompt(ADMIN)).toMatch(/Cite what you read/);
	});
});

describe("checking a call before it runs", () => {
	const disable = operation("users.disable");
	const id = crypto.randomUUID();

	test("a named tool's input is checked against the operation's own schemas", () => {
		expect(
			checkInput(disable.operation, "/admin/users/:id/disable", { path: { id } }),
		).toEqual({
			input: { path: { id } },
		});
		expect(
			checkInput(disable.operation, "/admin/users/:id/disable", { path: { id: "x" } }),
		).toMatchObject({ problem: expect.stringMatching(/path is not valid/) });
		expect(
			checkInput(disable.operation, "/admin/users/:id/disable", { id }),
		).toMatchObject({ problem: expect.stringMatching(/only path, query and body/) });
		expect(
			checkInput(disable.operation, "/admin/users/:id/disable", {
				path: { id },
				body: { x: 1 },
			}),
		).toEqual({ problem: "This operation takes no body values." });
	});

	test("query values are checked as the route reads them, as strings", () => {
		const list = operation("users.list");
		expect(checkInput(list.operation, "/admin/users", { query: {} })).toEqual({
			input: { query: {} },
		});
		expect(checkInput(list.operation, "/admin/users", { path: { id } })).toEqual({
			problem: "This operation takes no path values.",
		});
	});

	test("run_operation takes the risk of the operation it names", () => {
		const resolved = resolveCall(
			{
				name: "run_operation",
				input: { operation: "users.disable", input: { path: { id } } },
			},
			ADMIN,
		);
		expect(resolved).toMatchObject({
			kind: "operation",
			operation: { risk: "destructive" },
		});
	});

	test("an unknown or out-of-role name is refused with no request", () => {
		expect(resolveCall({ name: "users_nothing", input: {} }, ADMIN)).toMatchObject({
			kind: "answer",
			isError: true,
		});
		expect(
			resolveCall(
				{ name: "run_operation", input: { operation: "users.list" } },
				INSTRUCTOR,
			),
		).toMatchObject({ kind: "answer", isError: true });
		expect(resolveCall({ name: "users_list", input: {} }, INSTRUCTOR)).toMatchObject({
			kind: "answer",
			isError: true,
		});
		expect(
			resolveCall({ name: "run_operation", input: { nope: 1 } }, ADMIN),
		).toMatchObject({
			kind: "answer",
			isError: true,
		});
	});

	test("find_operation answers at once with what the person may run", () => {
		const found = resolveCall(
			{ name: "find_operation", input: { query: "disable" } },
			ADMIN,
		);
		expect(found.kind).toBe("answer");
		const text = found.kind === "answer" ? found.text : "";
		expect(JSON.parse(text).map((f: { name: string }) => f.name)).toContain(
			"users.disable",
		);
		const none = resolveCall(
			{ name: "find_operation", input: { query: "disable" } },
			{
				role: "administrator",
				readOnly: true,
			},
		);
		expect(none.kind === "answer" ? none.text : "").not.toContain("users.disable");
		expect(resolveCall({ name: "find_operation", input: {} }, ADMIN)).toMatchObject({
			isError: true,
		});
	});
});
