import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ChatOpenCard, ChatSessionRule } from "@portikus/contracts";
import {
	type ChatEventBody,
	cardForTool,
	PERMISSION_OPTION,
	type PermissionAnswerExtras,
	permissionResult,
	type ToolAsk,
} from "./claude-adapter.js";
import { type DecisionMemory, decisionForOption } from "./decisions.js";
import { splitSuggestions } from "./permission-rules.js";

export interface OpenCard {
	card: ChatOpenCard;
	input: Record<string, unknown>;
	ask: ToolAsk;
	settle: (result: PermissionResult) => void;
}

/**
 * The permission and question cards a chat is waiting on (SPEC.md §10.8).
 * Each waits, with no time limit, for the first answer from any attachment.
 */
export class OpenCards {
	private readonly cards = new Map<string, OpenCard>();

	constructor(
		private readonly broadcast: (event: ChatEventBody) => void,
		private readonly grantRules: (rules: ChatSessionRule[]) => Promise<void>,
		private readonly decisions: DecisionMemory,
	) {}

	/** The cards still open, for a snapshot. */
	get current(): ChatOpenCard[] {
		return [...this.cards.values()].map((open) => open.card);
	}

	/** Raise a card and wait for its answer. An aborted call clears the card. */
	ask(
		toolName: string,
		input: Record<string, unknown>,
		ask: ToolAsk & { signal: AbortSignal },
	): Promise<PermissionResult> {
		const card = cardForTool(toolName, input, ask);
		return new Promise<PermissionResult>((resolve) => {
			const settle = (result: PermissionResult) => {
				ask.signal.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => {
				if (!this.cards.delete(card.id)) return;
				this.broadcast({ type: "card.resolved", id: card.id });
				resolve({ behavior: "deny", message: "Cancelled." });
			};
			ask.signal.addEventListener("abort", onAbort);
			this.cards.set(card.id, { card, input, ask, settle });
			this.broadcast(
				card.type === "question"
					? { type: "question.requested", id: card.id, questions: card.questions }
					: { ...card, type: "permission.requested" },
			);
		});
	}

	/** First answer wins; a late or unknown answer is ignored. */
	answer(id: string, result: (open: OpenCard) => PermissionResult | null): void {
		const open = this.cards.get(id);
		if (!open) return;
		const decided = result(open);
		if (!decided) return;
		this.cards.delete(id);
		open.settle(decided);
		this.broadcast({ type: "card.resolved", id });
	}

	/**
	 * Like `answer`, but Always allow first grants the session rules, so the
	 * card is claimed before the wait and a second answer cannot also win.
	 */
	async answerPermission(
		id: string,
		optionId: string,
		extras: PermissionAnswerExtras,
	): Promise<void> {
		const open = this.cards.get(id);
		if (open?.card.type !== "permission") return;
		if (!open.card.options.some((option) => option.id === optionId)) return;
		this.cards.delete(id);
		let decision = decisionForOption(optionId);
		try {
			if (optionId === PERMISSION_OPTION.allowAlways && open.ask.suggestions) {
				await this.grantRules(splitSuggestions(open.ask.suggestions).sessionRules);
			}
		} catch {
			// The student chose to allow, so the tool still runs this once.
			decision = "allowed";
			throw new Error(
				"Allowed this once. The Always allow rule could not be saved, so Claude will ask again next time.",
			);
		} finally {
			open.settle(permissionResult(optionId, open.input, open.ask, extras));
			this.decisions.record(id, decision);
			this.broadcast({ type: "card.resolved", id, decision });
		}
	}

	/** Refuse every open card, as when the session ends. */
	denyAll(message: string): void {
		for (const [id, open] of this.cards) {
			open.settle({ behavior: "deny", message });
			this.cards.delete(id);
			this.broadcast({ type: "card.resolved", id });
		}
	}
}
