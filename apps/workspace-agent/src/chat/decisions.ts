import type { ChatCardDecision } from "@portikus/contracts";
import type { ChatEventBody } from "./agent.js";

/** How many answered permission cards the chat host remembers. */
export const MAX_REMEMBERED_DECISIONS = 500;

/**
 * The answers the student gave to permission cards, by tool call id, for the
 * life of the chat host and never stored (SPEC.md §10.8). A browser that
 * attaches later learns them from the replay.
 */
export class DecisionMemory {
	private readonly byToolId = new Map<string, ChatCardDecision>();

	record(toolId: string, decision: ChatCardDecision): void {
		this.byToolId.delete(toolId);
		this.byToolId.set(toolId, decision);
		if (this.byToolId.size > MAX_REMEMBERED_DECISIONS) {
			const oldest = this.byToolId.keys().next().value;
			if (oldest !== undefined) this.byToolId.delete(oldest);
		}
	}

	clear(): void {
		this.byToolId.clear();
	}

	/** One `card.resolved` per remembered decision whose tool call the history shows. */
	replayFor(history: readonly ChatEventBody[]): ChatEventBody[] {
		const events: ChatEventBody[] = [];
		for (const event of history) {
			if (event.type !== "tool.started") continue;
			const decision = this.byToolId.get(event.id);
			if (decision) events.push({ type: "card.resolved", id: event.id, decision });
		}
		return events;
	}
}
