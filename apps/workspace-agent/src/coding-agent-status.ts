import {
	type AgentCodingAgentStatus,
	type CodingAgent,
	type CodingAgentState,
	type CodingAgentSubagent,
	type CodingAgentSubagentPost,
	MAX_CODING_AGENT_TERMINALS,
	MAX_SUBAGENTS_PER_TERMINAL,
	type TerminalQuestion,
} from "@portikus/contracts";

/** Claude Code's subagent type when the call names none. */
const DEFAULT_SUBAGENT_TYPE = "general-purpose";

interface SubagentRow {
	row: CodingAgentSubagent;
	/** When the latest post that changed this row fired. */
	at: number;
	background: boolean;
	agentId?: string;
}

/**
 * One terminal's subagent rows, keyed by Agent tool call id, plus when each
 * call id's last post fired, kept after the row goes so a late post cannot
 * bring it back. Insertion order is age.
 */
interface SubagentRows {
	rows: Map<string, SubagentRow>;
	seen: Map<string, number>;
	/** Background stops that arrived before the post naming their agent id. */
	earlyStops: Map<string, number>;
}

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
	 * When each terminal's latest accepted hook fired, kept after a clear so a
	 * late post from before it cannot bring the entry back, and a mark for
	 * removed terminals. Hooks run in the background, so their posts can arrive
	 * out of order.
	 */
	private readonly firedAt = new Map<
		string,
		{ at: number; removed: boolean; clearedAt?: number }
	>();
	/**
	 * Subagent rows per terminal, apart from the state entry: their posts are
	 * ordered per row, not per terminal, so a state post cannot hide them.
	 */
	private readonly subagents = new Map<string, SubagentRows>();
	/**
	 * Each chat's conversation title, apart from the state entry so a state
	 * post keeps it. Drawn from prompts, so it is never logged (ADR 0074).
	 */
	private readonly titles = new Map<string, string>();
	/**
	 * The question each terminal's Claude Code waits on, kept by the question
	 * store, which holds at most one per terminal (ADR 0075). Never logged.
	 */
	private readonly questions = new Map<string, TerminalQuestion>();

	constructor(options: CodingAgentBoardOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	current(): AgentCodingAgentStatus[] {
		return [...this.entries.values()].map((entry) => {
			const title = this.titles.get(entry.terminalId);
			const question = this.questions.get(entry.terminalId);
			return {
				...entry,
				subagents: [...(this.subagents.get(entry.terminalId)?.rows.values() ?? [])].map(
					({ row }) => ({ ...row }),
				),
				...(title ? { title } : {}),
				...(question ? { question } : {}),
			};
		});
	}

	/**
	 * Record a chat's title, or that it has none. Only the chat host posts it,
	 * one post at a time, so the latest post wins. A closed terminal's is refused.
	 */
	title(terminalId: string, title: string | null): void {
		if (this.firedAt.get(terminalId)?.removed) return;
		if ((this.titles.get(terminalId) ?? null) === title) return;
		this.titles.delete(terminalId);
		if (title !== null) {
			this.titles.set(terminalId, title);
			while (this.titles.size > 2 * MAX_CODING_AGENT_TERMINALS) {
				const oldest = this.titles.keys().next().value;
				if (oldest === undefined) break;
				this.titles.delete(oldest);
			}
		}
		if (this.entries.has(terminalId)) this.changed();
	}

	/** Show a terminal's waiting question, or that it has none. A closed terminal's is refused. */
	question(terminalId: string, question: TerminalQuestion | undefined): void {
		if (question && this.firedAt.get(terminalId)?.removed) return;
		if (this.questions.get(terminalId) === question) return;
		if (question) this.questions.set(terminalId, question);
		else this.questions.delete(terminalId);
		if (this.entries.has(terminalId)) this.changed();
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
			subagents: [],
		});
		this.changed();
	}

	/** The agent ended; ignored when older than the last accepted post. */
	clear(terminalId: string, at: number): void {
		if (!this.accept(terminalId, at)) return;
		this.remember(terminalId, at, false, at);
		this.subagents.delete(terminalId);
		if (this.entries.delete(terminalId)) this.changed();
	}

	/**
	 * Apply one subagent hook post (SPEC.md §10.8). A foreground call finishes
	 * at its PostToolUse, a background one at the SubagentStop naming its
	 * agent id; a failed call removes its row. Stop finishes working foreground
	 * rows and UserPromptSubmit drops finished ones, each only for rows whose
	 * last post fired earlier.
	 */
	subagent(post: CodingAgentSubagentPost): void {
		const terminalId = post.terminal;
		const fired = this.firedAt.get(terminalId);
		if (fired?.removed) return;
		// A call that fired before the session ended can arrive after its clear.
		if (fired?.clearedAt !== undefined && post.at <= fired.clearedAt) return;
		const rows = this.subagentRows(terminalId);
		const changed = this.applySubagentPost(rows, post);
		if (changed && this.entries.has(terminalId)) this.changed();
	}

	/** Apply one post to a terminal's rows; true when a row changed. */
	private applySubagentPost(
		rows: SubagentRows,
		post: CodingAgentSubagentPost,
	): boolean {
		switch (post.event) {
			case "pre_tool_use":
				return this.startSubagent(rows, post);
			case "post_tool_use":
				return this.subagentReturned(rows, post);
			case "post_tool_use_failure":
				return this.subagentFailed(rows, post);
			case "subagent_stop":
				return this.subagentStopped(rows, post);
			case "stop":
				return this.finishForeground(rows, post.at);
			case "user_prompt_submit":
				return this.dropFinished(rows, post.at);
		}
	}

	private subagentRows(terminalId: string): SubagentRows {
		const rows = this.subagents.get(terminalId) ?? {
			rows: new Map(),
			seen: new Map(),
			earlyStops: new Map(),
		};
		// Each use moves the terminal to the newest slot, so eviction takes the idle.
		this.subagents.delete(terminalId);
		this.subagents.set(terminalId, rows);
		while (this.subagents.size > 2 * MAX_CODING_AGENT_TERMINALS) {
			const oldest = this.subagents.keys().next().value;
			if (oldest === undefined) break;
			this.subagents.delete(oldest);
		}
		return rows;
	}

	/** True, and the time recorded, when `at` is not older than the row's last post. */
	private newer(rows: SubagentRows, id: string, at: number): boolean {
		const last = rows.seen.get(id);
		if (last !== undefined && at < last) return false;
		rememberBounded(rows.seen, id, at);
		const entry = rows.rows.get(id);
		if (entry) entry.at = at;
		return true;
	}

	private startSubagent(rows: SubagentRows, post: CodingAgentSubagentPost): boolean {
		const id = post.tool_use_id;
		// A call id already seen is a repeat or arrived after its own end.
		if (id === undefined || rows.seen.has(id)) return false;
		rememberBounded(rows.seen, id, post.at);
		while (rows.rows.size >= MAX_SUBAGENTS_PER_TERMINAL) {
			const finished = [...rows.rows.entries()].find(
				([, entry]) => entry.row.state === "finished",
			);
			const oldest = finished?.[0] ?? rows.rows.keys().next().value;
			if (oldest === undefined) break;
			rows.rows.delete(oldest);
		}
		rows.rows.set(id, {
			row: {
				id,
				type: post.subagent_type ?? DEFAULT_SUBAGENT_TYPE,
				description: post.description ?? "",
				state: "working",
				since: this.now().toISOString(),
			},
			at: post.at,
			background: post.run_in_background === true,
		});
		return true;
	}

	private subagentReturned(rows: SubagentRows, post: CodingAgentSubagentPost): boolean {
		const id = post.tool_use_id;
		if (id === undefined || !this.newer(rows, id, post.at)) return false;
		const entry = rows.rows.get(id);
		if (!entry) return false;
		if (!entry.background) return this.finish(entry, post.at);
		// A background call returns at launch; its SubagentStop ends it.
		if (post.agent_id === undefined) return false;
		entry.agentId = post.agent_id;
		const stoppedAt = rows.earlyStops.get(post.agent_id);
		if (stoppedAt === undefined) return false;
		rows.earlyStops.delete(post.agent_id);
		return this.finish(entry, Math.max(entry.at, stoppedAt));
	}

	private subagentFailed(rows: SubagentRows, post: CodingAgentSubagentPost): boolean {
		const id = post.tool_use_id;
		if (id === undefined || !this.newer(rows, id, post.at)) return false;
		return rows.rows.delete(id);
	}

	private subagentStopped(rows: SubagentRows, post: CodingAgentSubagentPost): boolean {
		if (post.agent_id === undefined) return false;
		const found = [...rows.rows.entries()].find(
			([, entry]) => entry.agentId === post.agent_id,
		);
		if (!found) {
			rememberBounded(rows.earlyStops, post.agent_id, post.at);
			return false;
		}
		return this.newer(rows, found[0], post.at) && this.finish(found[1], post.at);
	}

	/** Finish working foreground rows whose last post fired before `at`. */
	private finishForeground(rows: SubagentRows, at: number): boolean {
		let changed = false;
		for (const [id, entry] of rows.rows) {
			if (entry.background || entry.at >= at) continue;
			if (this.finish(entry, at)) {
				rememberBounded(rows.seen, id, at);
				changed = true;
			}
		}
		return changed;
	}

	/** Drop finished rows whose last post fired before `at`. */
	private dropFinished(rows: SubagentRows, at: number): boolean {
		let changed = false;
		for (const [id, entry] of rows.rows) {
			if (entry.row.state !== "finished" || entry.at >= at) continue;
			rows.rows.delete(id);
			rememberBounded(rows.seen, id, at);
			changed = true;
		}
		return changed;
	}

	private finish(entry: SubagentRow, at: number): boolean {
		entry.at = Math.max(entry.at, at);
		if (entry.row.state === "finished") return false;
		entry.row = { ...entry.row, state: "finished", since: this.now().toISOString() };
		return true;
	}

	/**
	 * Drop a terminal's entry when it closes. Terminal ids are never reused, so
	 * every later post for the id is refused: a hook that fired before the close
	 * but arrived after it cannot bring the entry back.
	 */
	remove(terminalId: string): void {
		this.remember(terminalId, this.firedAt.get(terminalId)?.at ?? 0, true);
		this.subagents.delete(terminalId);
		this.titles.delete(terminalId);
		this.questions.delete(terminalId);
		if (this.entries.delete(terminalId)) this.changed();
	}

	private accept(terminalId: string, at: number): boolean {
		const last = this.firedAt.get(terminalId);
		if (last && (last.removed || at < last.at)) return false;
		this.remember(terminalId, at, false);
		return true;
	}

	private remember(
		terminalId: string,
		at: number,
		removed: boolean,
		clearedAt = this.firedAt.get(terminalId)?.clearedAt,
	): void {
		this.firedAt.delete(terminalId);
		this.firedAt.set(terminalId, { at, removed, clearedAt });
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

/** Set a key as the newest, keeping at most a few rows' worth of history. */
function rememberBounded(map: Map<string, number>, key: string, at: number): void {
	map.delete(key);
	map.set(key, at);
	while (map.size > 4 * MAX_SUBAGENTS_PER_TERMINAL) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}
