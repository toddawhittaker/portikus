import { type AssistantContext, SigninView } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { operationByName } from "../catalog/index.js";
import { mayRun } from "../mcp/caller.js";
import { planDiagnose } from "./diagnose.js";
import { systemPrompt } from "./tools.js";

/** Diagnose's fixed reads (SPEC.md section 20.5): every one only reads, and each kind names its own evidence. */

const ID = "0b9f6e0c-7d52-4a77-8f0e-9a3f6a2f1c11";

function reads(context: AssistantContext): string[] {
	return planDiagnose(context)?.reads.map((read) => read.operation) ?? [];
}

describe("what each kind of Diagnose reads", () => {
	test("health: the report, the last hour, and recent errors", () => {
		expect(reads({ kind: "health" })).toEqual([
			"health.get",
			"health.series",
			"logs.list",
		]);
	});

	test("a workspace: its detail, agent log, processes and audit rows for it", () => {
		expect(reads({ kind: "workspace", id: ID })).toEqual([
			"workspaces.get_detail",
			"workspaces.agent_log",
			"workspaces.list_processes",
			"audit.list",
		]);
		const audit = planDiagnose({ kind: "workspace", id: ID })?.reads.at(-1);
		expect(audit?.input).toEqual({ query: { workspace: ID } });
	});

	test("a job reads the get that matches its kind, then recent errors", () => {
		expect(reads({ kind: "job", id: `certificate:${ID}` })).toEqual([
			"certificate.get_job",
			"logs.list",
		]);
		expect(reads({ kind: "job", id: `image:${ID}` })).toEqual([
			"image.get_job",
			"logs.list",
		]);
		expect(reads({ kind: "job", id: "site:address" })).toEqual([
			"address.get",
			"logs.list",
		]);
		expect(reads({ kind: "job", id: "site:keep" })).toEqual([
			"address.get",
			"signin.get",
			"logs.list",
		]);
		expect(reads({ kind: "job", id: "site:proxy-hosts" })[0]).toBe("proxy_hosts.get");
		expect(reads({ kind: "job", id: "site:lti-platforms" })[0]).toBe("lms.get");
	});

	test("an alert reads the notifications, the health report and recent errors", () => {
		expect(reads({ kind: "alert", id: ID })).toEqual([
			"notifications.list",
			"health.get",
			"logs.list",
		]);
	});

	test("setup help reads what the page shows, then recent errors", () => {
		expect(reads({ kind: "setup", id: "lms" })).toEqual([
			"lms.get",
			"proxy_hosts.get",
			"logs.list",
		]);
		expect(reads({ kind: "setup", id: "signin" })).toEqual([
			"signin.get",
			"address.get",
			"logs.list",
		]);
		expect(planDiagnose({ kind: "setup", id: "lms" })?.request).toBe(
			"Help me set up the LMS platforms",
		);
		expect(planDiagnose({ kind: "setup", id: "signin" })?.request).toBe(
			"Help me set up single sign-on",
		);
	});

	test("an item the kind cannot name has no plan", () => {
		for (const context of [
			{ kind: "workspace" },
			{ kind: "workspace", id: "../x" },
			{ kind: "alert", id: "nope" },
			{ kind: "job" },
			{ kind: "job", id: ID },
			{ kind: "job", id: "site:unknown" },
			{ kind: "job", id: "image:not-a-uuid" },
			{ kind: "job", id: `image:${ID}:more` },
			{ kind: "setup" },
			{ kind: "setup", id: "network" },
		] satisfies AssistantContext[]) {
			expect(planDiagnose(context), JSON.stringify(context)).toBeNull();
		}
	});
});

describe("Diagnose only reads", () => {
	const contexts: AssistantContext[] = [
		{ kind: "health" },
		{ kind: "workspace", id: ID },
		{ kind: "alert", id: ID },
		{ kind: "setup", id: "lms" },
		{ kind: "setup", id: "signin" },
		{ kind: "job", id: `certificate:${ID}` },
		{ kind: "job", id: `image:${ID}` },
		...["proxy-hosts", "lti-platforms", "address", "signin", "keep", "rollback"].map(
			(kind) => ({ kind: "job" as const, id: `site:${kind}` }),
		),
	];

	test("every planned operation exists, is a read, and an administrator may run it with a read key", () => {
		for (const context of contexts) {
			const plan = planDiagnose(context);
			expect(plan, JSON.stringify(context)).not.toBeNull();
			for (const read of plan?.reads ?? []) {
				const found = operationByName(read.operation);
				expect(found, read.operation).toBeDefined();
				expect(found?.operation.risk, read.operation).toBe("read");
				expect(
					found && mayRun(found.operation, { role: "administrator", scope: "read" }),
					read.operation,
				).toBe(true);
			}
		}
	});

	test("the visible message is a short request naming the item", () => {
		expect(planDiagnose({ kind: "workspace", id: ID })?.request).toBe(
			`Diagnose workspace ${ID.slice(0, 8)}`,
		);
		expect(planDiagnose({ kind: "health" })?.request).toBe(
			"Diagnose the site's health",
		);
		expect(planDiagnose({ kind: "job", id: `image:${ID}` })?.request).toBe(
			"Diagnose a failed image job",
		);
	});

	test("the read-only system prompt asks for the likely cause from the reads, the same text every time", () => {
		const prompt = systemPrompt({ role: "administrator", readOnly: true }, false);
		expect(prompt).toContain("Give the most likely cause, using only those reads");
		expect(prompt).toBe(systemPrompt({ role: "administrator", readOnly: true }, false));
		expect(
			systemPrompt({ role: "administrator", readOnly: false }, false),
		).not.toContain("most likely cause");
	});

	test("a setup conversation's prompt explains, checks the guide and refuses secrets", () => {
		const prompt = systemPrompt(
			{ role: "administrator", readOnly: true, setup: true },
			false,
		);
		expect(prompt).toContain("check the saved values against the guide");
		expect(prompt).toContain("Never ask for, accept or repeat a secret");
		expect(prompt).not.toContain("most likely cause");
	});
});

/** The names of every property in a JSON schema, with the type of each. */
function properties(schema: unknown, found: Map<string, unknown[]> = new Map()) {
	if (Array.isArray(schema)) {
		for (const item of schema) properties(item, found);
	} else if (schema && typeof schema === "object") {
		for (const [key, value] of Object.entries(schema)) {
			if (key === "properties" && value && typeof value === "object") {
				for (const [name, sub] of Object.entries(value)) {
					const types = found.get(name) ?? [];
					types.push((sub as { type?: unknown }).type);
					found.set(name, types);
				}
			}
			properties(value, found);
		}
	}
	return found;
}

describe("setup reads carry no secret", () => {
	// A secret's value must never reach the model; a flag that one is set may.
	const SECRET_WORDS = /secret|password|private|apikey|serviceaccount/i;

	test.each(["lms.get", "proxy_hosts.get", "signin.get", "address.get"])(
		"%s has no field that could hold a secret value",
		(name) => {
			const output = operationByName(name)?.operation.output;
			expect(output, name).toBeDefined();
			const found = properties(z.toJSONSchema(output as z.ZodType, { io: "output" }));
			for (const [field, types] of found) {
				if (!SECRET_WORDS.test(field)) continue;
				expect(field, `${name} field ${field}`).toMatch(/Set$/);
				expect(types, `${name} field ${field}`).toEqual(["boolean"]);
			}
		},
	);

	test("sign-in's view says a secret is set, never what it is", () => {
		const found = properties(z.toJSONSchema(SigninView, { io: "output" }));
		expect(found.get("clientSecretSet")).toEqual(["boolean"]);
		expect(found.has("clientSecret")).toBe(false);
		expect(found.has("googleServiceAccountKey")).toBe(false);
	});
});
