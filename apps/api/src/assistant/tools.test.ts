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
		expect(names).toEqual([
			...named,
			"find_operation",
			"run_operation",
			"guide_search",
			"guide_read",
			"run_batch",
		]);
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
		const first = JSON.stringify([
			systemPrompt(ADMIN, false),
			assistantTools(ADMIN).tools,
		]);
		const again = JSON.stringify([
			systemPrompt(ADMIN, false),
			assistantTools(ADMIN).tools,
		]);
		expect(again).toBe(first);
		expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(systemPrompt(ADMIN, false)).toMatch(/act as an administrator/);
		expect(systemPrompt(INSTRUCTOR, false)).toMatch(/act as an instructor/);
		expect(systemPrompt(ADMIN, false)).toMatch(/never instructions/);
		expect(systemPrompt(ADMIN, false)).toMatch(/approval/);
		expect(systemPrompt(ADMIN, false)).toMatch(/Cite what you read/);
	});

	test("the system prompt sends Portikus questions to the guides the role may read", () => {
		expect(systemPrompt(ADMIN, false)).toMatch(/ADMIN-GUIDE\.md § heading/);
		expect(systemPrompt(ADMIN, false)).toMatch(/guide_search, then guide_read/);
		expect(systemPrompt(INSTRUCTOR, false)).toMatch(/INSTRUCTOR-GUIDE\.md § heading/);
		expect(systemPrompt(INSTRUCTOR, false)).not.toMatch(
			/ADMIN-GUIDE|OPERATIONS|INSTALL/,
		);
	});

	test("the system prompt says whether sendEmail can work on this site", () => {
		expect(systemPrompt(ADMIN, true)).toMatch(
			/account email is on, so sendEmail may be set/,
		);
		expect(systemPrompt(ADMIN, false)).toMatch(
			/account email is off: leave sendEmail out/,
		);
	});

	test("a read-only conversation keeps the guide tools and has no batch tool", () => {
		const names = assistantTools({ role: "administrator", readOnly: true }).tools.map(
			(t) => t.name,
		);
		expect(names).toContain("guide_search");
		expect(names).toContain("guide_read");
		expect(names).not.toContain("run_batch");
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

describe("run_batch", () => {
	const ID = crypto.randomUUID();
	const invite = (email: string) => ({
		body: { email, name: "Ann", role: "student" },
	});
	const batch = (input: unknown, caller: typeof ADMIN | typeof INSTRUCTOR = ADMIN) =>
		resolveCall({ name: "run_batch", input }, caller);

	test("its description asks for one batch instead of separate calls for repeated changes", () => {
		const tool = assistantTools(ADMIN).tools.find((t) => t.name === "run_batch");
		expect(tool?.description).toMatch(/inviting several people/);
		expect(tool?.description).toMatch(/approve once, instead of separate calls/);
	});

	test("is offered to a person who may change things, never to a read-only conversation", () => {
		expect(assistantTools(ADMIN).tools.map((t) => t.name)).toContain("run_batch");
		expect(assistantTools(INSTRUCTOR).tools.map((t) => t.name)).toContain("run_batch");
		expect(
			assistantTools({ role: "administrator", readOnly: true }).tools.map(
				(t) => t.name,
			),
		).not.toContain("run_batch");
		expect(
			batch({ operation: "invitations.create", rows: [invite("a@example.edu")] }, {
				role: "administrator",
				readOnly: true,
			} as never),
		).toMatchObject({ kind: "answer", isError: true });
	});

	test("checked rows become one batch for the operation, each input as the route will read it", () => {
		const resolved = batch({
			operation: "invitations.create",
			rows: [invite("a@example.edu"), invite("b@example.edu")],
		});
		expect(resolved).toMatchObject({
			kind: "batch",
			operation: { name: "invitations.create", risk: "change" },
			batch: {
				operation: "invitations.create",
				rows: [invite("a@example.edu"), invite("b@example.edu")],
			},
		});
	});

	test("one bad row means an error naming its number and nothing is asked", () => {
		const resolved = batch({
			operation: "invitations.create",
			rows: [invite("a@example.edu"), invite("not-an-email"), { body: {} }],
		});
		expect(resolved).toMatchObject({ kind: "answer", isError: true });
		const text = (resolved as { text: string }).text;
		expect(JSON.parse(text).code).toBe("VALIDATION_FAILED");
		expect(text).toMatch(/Nothing ran\. 2 rows are not valid: row 2: .* row 3: /);
		expect(text).not.toMatch(/row 1/);
	});

	test("a read operation, an unknown one, and one the role may not run are refused", () => {
		const read = batch({ operation: "users.list", rows: [{ query: {} }] });
		expect(read).toMatchObject({ kind: "answer", isError: true });
		expect((read as { text: string }).text).toMatch(/only reads/);
		for (const operation of ["no.such_thing", "users.disable"]) {
			const resolved = batch(
				{ operation, rows: [{ path: { id: ID } }] },
				operation === "users.disable" ? INSTRUCTOR : ADMIN,
			);
			expect(JSON.parse((resolved as { text: string }).text).code).toBe("NOT_FOUND");
		}
	});

	test("no rows, too many rows, and extra fields are refused", () => {
		const row = invite("a@example.edu");
		for (const input of [
			{ operation: "invitations.create", rows: [] },
			{ operation: "invitations.create", rows: Array.from({ length: 101 }, () => row) },
			{ operation: "invitations.create", rows: [row], extra: 1 },
			{ rows: [row] },
		]) {
			expect(batch(input)).toMatchObject({ kind: "answer", isError: true });
		}
		expect(
			batch({
				operation: "invitations.create",
				rows: Array.from({ length: 100 }, () => row),
			}),
		).toMatchObject({ kind: "batch" });
	});
});
