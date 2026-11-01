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
	/**
	 * When each terminal's latest accepted hook fired, kept after a clear or a
	 * removal so a late post from before it cannot bring the entry back. Hooks
	 * run in the background, so their posts can arrive out of order.
	 */
	private readonly firedAt = new Map<string, { at: number; removed: boolean }>();

	constructor(options: CodingAgentBoardOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	current(): AgentCodingAgentStatus[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	/**
	 * Record a state that a hook reported at `at`. A post older than the last
	 * accepted one is ignored; a repeat of the current state keeps its time
	 * and tells no one.
	 */
	set(
		terminalId: string,
		agent: CodingAgent,
		state: CodingAgentState,
		at: number,
	): void {
		if (!this.accept(terminalId, at)) return;
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

	/** The agent ended; ignored when older than the last accepted post. */
	clear(terminalId: string, at: number): void {
		if (!this.accept(terminalId, at)) return;
		if (this.entries.delete(terminalId)) this.changed();
	}

	/**
	 * Drop a terminal's entry when it closes. Its last time stays, so a hook
	 * post that arrives late cannot bring the entry back.
	 */
	remove(terminalId: string): void {
		const last = this.firedAt.get(terminalId);
		if (last) this.remember(terminalId, last.at, true);
		if (this.entries.delete(terminalId)) this.changed();
	}

	private accept(terminalId: string, at: number): boolean {
		const last = this.firedAt.get(terminalId);
		if (last && (last.removed ? at <= last.at : at < last.at)) return false;
		this.remember(terminalId, at, false);
		return true;
	}

	private remember(terminalId: string, at: number, removed: boolean): void {
		this.firedAt.delete(terminalId);
		this.firedAt.set(terminalId, { at, removed });
		// Cleared and removed terminals leave a time behind; keep that bounded too.
		while (this.firedAt.size > 2 * MAX_CODING_AGENT_TERMINALS) {
			const oldest = this.firedAt.keys().next().value;
			if (oldest === undefined) break;
			this.firedAt.delete(oldest);
		}
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
