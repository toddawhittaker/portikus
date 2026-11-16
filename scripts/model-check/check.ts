import type { Expect } from "./tasks.ts";

/**
 * Judging one task from facts the runner gathered (SPEC.md section 20.5,
 * "Tested models"). Kept apart from the runner so it can be unit tested
 * without a site or a model.
 */

/** Operation and tool names in one form: a catalog name's first dot becomes `_`, as the tool names do. */
function nameKey(name: string): string {
	return name.replace(".", "_");
}

export type CallFact = {
	/** The operation's or tool's name, in nameKey form. */
	name: string;
	/** True when its result was an error; null when it never finished. */
	isError: boolean | null;
	input: unknown;
};

export type Facts = {
	calls: CallFact[];
	cards: { name: string; batchOperation: string | null; rows: number | null }[];
	/** `assistant.used` audit rows for this task's person since it started. */
	audit: { operation: string; result: string }[];
	/** The assistant's replies, used only to look for a guide citation. */
	replyText: string;
	target: { disabled: boolean; role: string } | null;
	invitations: number | null;
};

/**
 * The tool calls a step made, as the facts count them. A call through
 * `run_operation` counts as the operation it names.
 */
export function callFact(
	event: { name: string; input: unknown },
	isError: boolean | null,
): CallFact {
	const input = event.input as { operation?: unknown } | null;
	const named =
		event.name === "run_operation" && typeof input?.operation === "string"
			? input.operation
			: event.name;
	return { name: nameKey(named), isError, input: event.input };
}

/** The first expectation that does not hold, as a short reason; null when all hold. */
export function judge(expect: Expect, facts: Facts): string | null {
	return (
		judgeCalls(expect, facts) ??
		judgeCards(expect, facts) ??
		judgeRuns(expect, facts) ??
		judgeState(expect, facts) ??
		judgeGuide(expect, facts)
	);
}

function judgeCalls(expect: Expect, facts: Facts): string | null {
	const called = new Set(facts.calls.map((c) => c.name));
	for (const name of expect.called ?? []) {
		if (!called.has(nameKey(name))) return `never called ${name}`;
	}
	for (const name of expect.refused ?? []) {
		const refused = facts.calls.some(
			(c) => c.name === nameKey(name) && c.isError === true,
		);
		if (!refused) return `${name} was not called and refused`;
	}
	return null;
}

function judgeCards(expect: Expect, facts: Facts): string | null {
	if (!expect.cards) return null;
	const seen = facts.cards.map(describeCard).join(", ") || "none";
	const wanted = expect.cards.map((c) => describeCard(cardKey(c))).join(", ") || "none";
	return seen === wanted ? null : `cards: expected ${wanted}, saw ${seen}`;
}

function judgeRuns(expect: Expect, facts: Facts): string | null {
	const ranOk = new Set(
		facts.audit
			.filter((row) => row.result === "ok")
			.map((row) => nameKey(row.operation)),
	);
	for (const name of expect.ran ?? []) {
		if (!ranOk.has(nameKey(name))) return `${name} did not run`;
	}
	for (const name of expect.notRan ?? []) {
		if (ranOk.has(nameKey(name))) return `${name} ran but must not`;
	}
	return null;
}

function judgeState(expect: Expect, facts: Facts): string | null {
	for (const check of expect.state ?? []) {
		if ("invitations" in check) {
			if (facts.invitations !== check.invitations) {
				return `expected ${check.invitations} task invitations, found ${facts.invitations ?? "unknown"}`;
			}
			continue;
		}
		const target = facts.target;
		if (!target) return "the target account was not found";
		if ("disabled" in check && target.disabled !== check.disabled) {
			return check.disabled ? "the target is not disabled" : "the target was disabled";
		}
		if ("role" in check && target.role !== check.role) {
			return `the target's role is ${target.role}, not ${check.role}`;
		}
	}
	return null;
}

function judgeGuide(expect: Expect, facts: Facts): string | null {
	if (!expect.guide) return null;
	const { file, heading } = expect.guide;
	const read = facts.calls.some((c) => {
		if (c.name !== "guide_read" || c.isError !== false) return false;
		const input = c.input as { file?: unknown; heading?: unknown } | null;
		return (
			input?.file === file &&
			typeof input.heading === "string" &&
			input.heading.toLowerCase().includes(heading.toLowerCase())
		);
	});
	if (!read) return `never read ${file} § ${heading}`;
	if (!facts.replyText.includes(`${file} §`))
		return `the reply does not cite ${file} §`;
	return null;
}

function cardKey(card: { operation: string; rows?: number }): Facts["cards"][number] {
	return card.rows === undefined
		? { name: nameKey(card.operation), batchOperation: null, rows: null }
		: { name: "run_batch", batchOperation: card.operation, rows: card.rows };
}

function describeCard(card: Facts["cards"][number]): string {
	return card.batchOperation === null
		? card.name
		: `run_batch(${nameKey(card.batchOperation)} x${card.rows})`;
}
