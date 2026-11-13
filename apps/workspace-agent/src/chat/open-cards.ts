import type { ChatOpenCard } from "@portikus/contracts";
import type { CardAnswer, CardOutcome, CardSettle, ChatEventBody } from "./agent.js";
import { DecisionMemory } from "./decisions.js";

interface OpenCard {
	card: ChatOpenCard;
	settle: CardSettle;
	/** Detaches the abort listener once the card is answered. */
	release: () => void;
}

/**
 * The permission and question cards a chat is waiting on (SPEC.md §10.8).
 * Each waits, with no time limit, for the first answer from any
 * attachment. The driver that opened a card settles it with its agent.
 */
export class OpenCards {
	private readonly cards = new Map<string, OpenCard>();
	private readonly decisions = new DecisionMemory();

	constructor(private readonly broadcast: (event: ChatEventBody) => void) {}

	/** The answers to replay after a history: one per decision whose tool call it shows. */
	replayDecisions(history: readonly ChatEventBody[]): ChatEventBody[] {
		return this.decisions.replayFor(history);
	}

	/** Forget every answer, as when the chat moves to a new conversation. */
	clearDecisions(): void {
		this.decisions.clear();
	}

	/** The cards still open, for a snapshot. */
	get current(): ChatOpenCard[] {
		return [...this.cards.values()].map((open) => open.card);
	}

	/** Show a card. An abort clears it and settles it as closed. */
	open(card: ChatOpenCard, settle: CardSettle, signal?: AbortSignal): void {
		const onAbort = () => {
			if (!this.cards.delete(card.id)) return;
			this.broadcast({ type: "card.resolved", id: card.id });
			void settle({ type: "closed" });
		};
		signal?.addEventListener("abort", onAbort);
		const release = () => signal?.removeEventListener("abort", onAbort);
		this.cards.set(card.id, { card, settle, release });
		this.broadcast(
			card.type === "question"
				? { type: "question.requested", id: card.id, questions: card.questions }
				: { ...card, type: "permission.requested" },
		);
	}

	/**
	 * First answer wins; a late answer, one for an unknown card, or one that
	 * does not fit the card is ignored. The card is claimed before the
	 * driver settles it, so a second answer cannot also win while it waits.
	 */
	async answer(
		id: string,
		answer: Exclude<CardAnswer, { type: "closed" }>,
	): Promise<void> {
		const open = this.cards.get(id);
		if (!open || open.card.type !== answer.type) return;
		if (
			answer.type === "permission" &&
			open.card.type === "permission" &&
			!open.card.options.some((option) => option.id === answer.optionId)
		) {
			return;
		}
		this.cards.delete(id);
		open.release();
		const settled = open.settle(answer);
		// A settle that need not wait resolves the card before the agent moves on.
		const outcome: CardOutcome = settled instanceof Promise ? await settled : settled;
		const { decision, error } = outcome;
		if (decision) this.decisions.record(id, decision);
		this.broadcast({ type: "card.resolved", id, ...(decision ? { decision } : {}) });
		if (error) throw new Error(error);
	}
}
