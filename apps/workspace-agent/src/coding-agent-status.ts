import {
	type AgentCodingAgentStatus,
	type CodingAgent,
	type CodingAgentState,
	MAX_CODING_AGENT_TERMINALS,
} from "@portikus/contracts";

type Listener = (terminals: AgentCodingAgentStatus[]) => void;

export interface CodingAgentBoardOptions {
	now?: () => Date;
}

/**
 * What each terminal's coding agent is doing, as its own hooks last said
 * (SPEC.md §10.8). Memory only: a restart forgets it, and the next hook
 * sets it again. Any process in the workspace can post, so this drives the
 * student's screen and nothing else.
 */
export class CodingAgentBoard {
	private readonly now: () => Date;
	/** Insertion order is age, so the oldest entry goes first past the cap. */
	private readonly entries = new Map<string, AgentCodingAgentStatus>();
	private readonly listeners = new Set<Listener>();

	constructor(options: CodingAgentBoardOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	current(): AgentCodingAgentStatus[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	/** Record a state; a repeat of the current one keeps its time and tells no one. */
	set(terminalId: string, agent: CodingAgent, state: CodingAgentState): void {
		const existing = this.entries.get(terminalId);
		if (existing?.agent === agent && existing.state === state) return;
		this.entries.delete(terminalId);
		while (this.entries.size >= MAX_CODING_AGENT_TERMINALS) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		this.entries.set(terminalId, {
			terminalId,
			agent,
			state,
			since: this.now().toISOString(),
		});
		this.changed();
	}

	/** Forget a terminal, when its agent ends or the terminal closes. */
	remove(terminalId: string): void {
		if (this.entries.delete(terminalId)) this.changed();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(): void {
		const terminals = this.current();
		for (const listener of this.listeners) listener(terminals);
	}
}
