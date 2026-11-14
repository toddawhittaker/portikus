import {
	ChatCardQuestion,
	type ChatOpenCard,
	MAX_CHAT_PLAN_CHARS,
	MAX_CHAT_QUESTION_HEADER_CHARS,
	MAX_CHAT_QUESTION_OPTIONS,
	MAX_CHAT_QUESTIONS,
} from "@portikus/contracts";
import { shortenedInput } from "../claude-adapter.js";
import type { ToolRow } from "./mapper.js";
import type { UserInputRequest } from "./protocol.js";
import { shortTitle } from "./title.js";

/**
 * The cards Codex's requests raise (SPEC.md §10.8). Each button carries
 * the decision Codex receives. "Always" rules and exec-policy amendments
 * are never offered: both write a lasting rule into the student's
 * `~/.codex`, which the chat could not show or revoke.
 */

type PermissionCard = Extract<ChatOpenCard, { type: "permission" }>;
type Option = PermissionCard["options"][number];

const ALLOW: Option = { id: "accept", label: "Allow once", decision: "allowed" };
const ALLOW_SESSION: Option = {
	id: "acceptForSession",
	label: "Allow for this chat",
	decision: "allowedAlways",
};

/**
 * The buttons for a command or file-change approval, from the decisions
 * Codex lists. Deny is `decline`, or `cancel` (which also stops the turn)
 * when Codex does not list `decline`. A request with no list gets Allow
 * and Deny.
 */
export function approvalOptions(
	available: readonly unknown[] | null | undefined,
): Option[] {
	const listed = new Set(
		(available ?? []).filter((each): each is string => typeof each === "string"),
	);
	const options: Option[] = [];
	if (!available || listed.has("accept")) options.push(ALLOW);
	if (listed.has("acceptForSession")) options.push(ALLOW_SESSION);
	const deny =
		available && !listed.has("decline") && listed.has("cancel") ? "cancel" : "decline";
	options.push({ id: deny, label: "Deny", decision: "denied" });
	return options;
}

/** A command or file-change approval: the same tool name and input as the item's row. */
export function approvalCard(row: ToolRow, options: Option[]): PermissionCard {
	const what =
		row.name === "commandExecution" ? `run ${row.title}` : `change ${row.title}`;
	return {
		type: "permission",
		id: row.id,
		toolName: row.name,
		title: shortTitle(`Allow Codex to ${what}?`),
		input: row.input,
		options,
	};
}

const MCP_OPTIONS: Option[] = [
	ALLOW,
	ALLOW_SESSION,
	{ id: "decline", label: "Deny", decision: "denied" },
];

/** Codex's answer to an MCP tool approval; "for this chat" is Codex's session grant. */
export function mcpAnswer(optionId: string): unknown {
	if (optionId === ALLOW.id) return { action: "accept", content: {}, _meta: null };
	if (optionId === ALLOW_SESSION.id) {
		return { action: "accept", content: {}, _meta: { persist: "session" } };
	}
	return { action: "decline", content: null, _meta: null };
}

/** An MCP tool approval, drawn like the tool call's own row. */
export function mcpCard(
	id: string,
	server: string,
	tool: string,
	row: ToolRow | undefined,
): PermissionCard {
	return {
		type: "permission",
		id,
		toolName: "mcpToolCall",
		title: shortTitle(`Allow ${server} to run ${tool}?`),
		input: row?.input ?? shortenedInput({ server, tool, arguments: null }),
		options: MCP_OPTIONS,
	};
}

/** The plan card's buttons: implement in Auto or in Ask, or keep planning. */
export const PLAN_OPTION = {
	auto: "implement-auto",
	ask: "implement-ask",
	keepPlanning: "keep-planning",
} as const;

export function planCard(id: string, plan: string): PermissionCard {
	return {
		type: "permission",
		id,
		toolName: "plan",
		title: "Codex has a plan. Start working on it?",
		input: {},
		plan: plan.slice(0, MAX_CHAT_PLAN_CHARS),
		options: [
			{ id: PLAN_OPTION.auto, label: "Yes, in Auto", decision: "allowed" },
			{ id: PLAN_OPTION.ask, label: "Yes, and ask first", decision: "allowed" },
			{ id: PLAN_OPTION.keepPlanning, label: "No, keep planning", decision: "denied" },
		],
	};
}

/**
 * A question card, or null when the questions do not fit one. Codex's
 * questions may have no options (the student types an answer) and may be
 * secret, which the browser masks.
 */
export function questionCard(request: UserInputRequest): ChatOpenCard | null {
	if (request.questions.length === 0 || request.questions.length > MAX_CHAT_QUESTIONS) {
		return null;
	}
	const questions: ChatCardQuestion[] = [];
	for (const question of request.questions) {
		const shaped = ChatCardQuestion.safeParse({
			question: question.question,
			header: question.header.slice(0, MAX_CHAT_QUESTION_HEADER_CHARS),
			multiSelect: false,
			options: (question.options ?? [])
				.slice(0, MAX_CHAT_QUESTION_OPTIONS)
				.map((option) => ({
					label: option.label,
					description: option.description ?? "",
				})),
			...(question.isSecret ? { secret: true } : {}),
		});
		if (!shaped.success) return null;
		questions.push(shaped.data);
	}
	return { type: "question", id: request.itemId, questions };
}

/** The browser's answers, keyed by question text, as Codex takes them, keyed by question id. */
export function questionAnswer(
	request: UserInputRequest,
	answers: Record<string, string>,
): { answers: Record<string, { answers: string[] }> } {
	const byId: Record<string, { answers: string[] }> = {};
	for (const question of request.questions) {
		const answer = answers[question.question];
		byId[question.id] = { answers: answer ? [answer] : [] };
	}
	return { answers: byId };
}
