/**
 * The state of one chat tab, built from the events on its socket (SPEC.md
 * §10.8). The socket sends a `snapshot` first, then the history as replayed
 * events, then live ones; the store applies them in `seq` order and drops
 * anything stale, malformed, or sent before the snapshot. Nothing here is persisted or logged:
 * the conversation lives in the workspace only (SPEC.md §25.10).
 */
import {
	CHAT_START_SETTINGS,
	type ChatAttachment,
	type ChatCardDecision,
	ChatClientMessage,
	type ChatCommand,
	type ChatEffort,
	type ChatMcpServer,
	type ChatModeInfo,
	type ChatModelInfo,
	type ChatOpenCard,
	type ChatPermissionMode,
	ChatServerEvent,
	type ChatSessionRule,
	type ChatSignIn,
	type ChatToolOutputPart,
	type CodingAgent,
	chatStartMode,
	MAX_CHAT_SERVER_FRAME_BYTES,
	type ChatShellItem as ShellFields,
} from "@portikus/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

export interface ChatMessageItem {
	kind: "message";
	key: string;
	id: string;
	role: "user" | "assistant";
	markdown: string;
	attachments: ChatAttachment[];
	/** Deltas are still arriving for it. */
	streaming: boolean;
	turnId: string | null;
	/** The student sent it while the agent was working; only live, a reload does not know. */
	whileWorking?: boolean;
}

export interface ChatToolItem {
	kind: "tool";
	key: string;
	id: string;
	name: string;
	title: string;
	input: unknown;
	output: ChatToolOutputPart[];
	/** A tool the turn ended without finishing is "stopped". */
	status: "running" | "done" | "error" | "stopped";
	turnId: string | null;
	/** How the student answered this call's permission card; absent when no card was answered. */
	decision?: ChatCardDecision;
}

interface ChatErrorItem {
	kind: "error";
	key: string;
	message: string;
	turnId: string | null;
}

/**
 * A `!` command the host ran and its output. The student's own action, so it
 * belongs to no turn and starts none.
 */
export interface ChatShellItem extends Omit<ShellFields, "kind"> {
	kind: "shell";
	key: string;
	turnId: null;
}

/** Where the chat changed agents: a divider in the conversation (SPEC.md §10.8). */
export interface ChatHandoffItem {
	kind: "handoff";
	key: string;
	from: CodingAgent;
	to: CodingAgent;
	/** The oldest turns that did not fit the new agent's context window. */
	droppedTurns: number;
	/** The new agent could not take the conversation in, so it started without it. */
	failed: boolean;
	turnId: null;
}

export type ChatItem =
	| ChatMessageItem
	| ChatToolItem
	| ChatShellItem
	| ChatErrorItem
	| ChatHandoffItem;

export interface ChatTurn {
	id: string;
	/** Epoch milliseconds from the host's `at`, so replayed turns keep their real length. */
	startedAt: number;
	finishedAt: number | null;
	status: "running" | "done" | "interrupted" | "error";
	/**
	 * Only the snapshot said a turn was running, so `startedAt` is when the
	 * snapshot arrived; the replayed `turn.started` corrects it.
	 */
	estimated: boolean;
}

export interface ChatSettings {
	agent: "claude" | "codex";
	model: string;
	effort: ChatEffort;
	mode: ChatPermissionMode;
}

type ChatConnection =
	| "connecting"
	| "open"
	| "reconnecting"
	/** Retrying stopped; the page must be reloaded. */
	| "lost"
	/** The user has too many chat sockets open (SPEC.md §24.13). */
	| "tooMany"
	/** The tab is not a chat, or no longer exists. */
	| "notFound";

export interface ChatState {
	connection: ChatConnection;
	/** A snapshot has arrived at least once. */
	loaded: boolean;
	/** Messages, tool calls and errors, oldest first. */
	items: ChatItem[];
	turns: Record<string, ChatTurn>;
	currentTurnId: string | null;
	/**
	 * The `seq` of a message the student sent while Claude worked. Claude takes
	 * it in at its next step, so the turn divides there, not at the echo.
	 */
	pendingSplit: number | null;
	/** Cards waiting for an answer, oldest first. */
	cards: ChatOpenCard[];
	/**
	 * How each answered permission card was decided, by tool call id. Kept
	 * apart from the items so a decision that arrives before its tool call
	 * still lands on it; a snapshot empties it, and the host replays the
	 * decisions it remembers after the history.
	 */
	decisions: Record<string, ChatCardDecision>;
	/** The snapshot left out earlier history. */
	truncated: boolean;
	/** The latest `settings` event; null until one arrives. */
	settings: ChatSettings | null;
	/** The models the agent offers, as the host last listed them; empty until it does. */
	models: ChatModelInfo[];
	/** The permission modes the host offers; empty until it lists them, or when it never does. */
	modes: ChatModeInfo[];
	/** The student's MCP servers and how each stands, as the host last listed them. */
	mcp: ChatMcpServer[];
	/** Rules granted with Always allow that last for this session, as the host reports them. */
	sessionRules: ChatSessionRule[];
	/** Whether the student is signed in to the agent, as the host last said; `unknown` warns of nothing. */
	signIn: ChatSignIn;
	/** A Check again was sent and the host has not answered yet. */
	signInChecking: boolean;
	/** The slash commands on offer, as the host last listed them; empty until it does. */
	commands: ChatCommand[];
	/** How full the context is and when the prompt cache goes cold; null until the host says. */
	context: ChatContextUsage | null;
	/** Frames that failed validation and were dropped. */
	invalidFrames: number;
	/** When the last snapshot was applied, by the browser clock. */
	snapshotAt: number;
	/** The `seq` of the last applied event; -1 before any. */
	lastSeq: number;
	/** A (re)connected socket has not sent its snapshot yet. */
	awaitingSnapshot: boolean;
	/** The `seq` of the newest user message, which tells the composer its send arrived. */
	lastUserMessageSeq: number;
	/** The newest `error` event, which tells the composer a send or change was refused. */
	lastError: { seq: number; message: string } | null;
	/**
	 * The newest frame of a watched subagent's conversation. The subagent view
	 * applies each one to a store of its own; the chat's sequence ignores them.
	 */
	subagentFrame: SubagentFrame | null;
}

type SubagentFrame = Extract<ChatServerEvent, { type: "subagent" }>;
/** Every event but a subagent's or a rename's answer, which never enter the chat's own sequence. */
type ChatEvent = Exclude<ChatServerEvent, SubagentFrame | { type: "rename.result" }>;

type ChatContextUsage = Pick<
	Extract<ChatServerEvent, { type: "context" }>,
	"usedTokens" | "windowTokens" | "cache"
> & {
	/** Browser clock minus host clock when the event arrived; 0 when the host sent no time. */
	clockOffsetMs: number;
};

export const initialChatState: ChatState = {
	connection: "connecting",
	loaded: false,
	items: [],
	turns: {},
	currentTurnId: null,
	pendingSplit: null,
	cards: [],
	decisions: {},
	truncated: false,
	settings: null,
	models: [],
	modes: [],
	mcp: [],
	sessionRules: [],
	signIn: "unknown",
	signInChecking: false,
	commands: [],
	context: null,
	invalidFrames: 0,
	snapshotAt: 0,
	lastSeq: -1,
	awaitingSnapshot: true,
	lastUserMessageSeq: -1,
	lastError: null,
	subagentFrame: null,
};

/** Parse one raw socket frame; null when it is not a valid server event. */
function parseChatFrame(data: unknown): ChatServerEvent | null {
	if (typeof data !== "string") return null;
	// Each character is at least one byte, so a longer string is surely too big.
	if (data.length > MAX_CHAT_SERVER_FRAME_BYTES) return null;
	let json: unknown;
	try {
		json = JSON.parse(data);
	} catch {
		return null;
	}
	const parsed = ChatServerEvent.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/** Apply one raw frame: validate it, then order it after the snapshot by `seq`. */
export function receiveChatFrame(
	state: ChatState,
	data: unknown,
	now: number,
): ChatState {
	const event = parseChatFrame(data);
	if (event === null) return { ...state, invalidFrames: state.invalidFrames + 1 };
	return receiveChatEvent(state, event, now);
}

export function receiveChatEvent(
	state: ChatState,
	event: ChatServerEvent,
	now: number,
): ChatState {
	if (event.type === "subagent") return { ...state, subagentFrame: event };
	// Only the left pane's rename reads its answer.
	if (event.type === "rename.result") return state;
	if (event.type === "snapshot") return applySnapshot(state, event, now);
	// The contract puts the snapshot first, so anything earlier is stale.
	if (state.awaitingSnapshot) return state;
	return applyInOrder(state, event, now);
}

function applyInOrder(state: ChatState, event: ChatEvent, now: number): ChatState {
	if (event.seq <= state.lastSeq) return state;
	return { ...applyChatEvent(state, event, now), lastSeq: event.seq };
}

function applySnapshot(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "snapshot" }>,
	now: number,
): ChatState {
	const turnId = event.turnRunning ? `turn-${event.seq}` : null;
	return {
		...state,
		loaded: true,
		awaitingSnapshot: false,
		snapshotAt: now,
		lastSeq: event.seq,
		truncated: event.truncated,
		cards: event.cards,
		items: [],
		decisions: {},
		// A new snapshot may be a new session; the host sends its context after.
		context: null,
		// Or a new agent after a swap; its host says where it stands after the snapshot.
		signIn: "unknown",
		signInChecking: false,
		turns: turnId
			? {
					[turnId]: {
						id: turnId,
						startedAt: now,
						finishedAt: null,
						status: "running",
						estimated: true,
					},
				}
			: {},
		currentTurnId: turnId,
		pendingSplit: null,
	};
}

function replaceItem(
	items: ChatItem[],
	key: string,
	update: (item: ChatItem) => ChatItem,
): ChatItem[] | null {
	// The item being updated is nearly always one of the last.
	for (let at = items.length - 1; at >= 0; at--) {
		const item = items[at];
		if (item?.key === key) {
			const next = items.slice();
			next[at] = update(item);
			return next;
		}
	}
	return null;
}

/** One live event applied to the state, with no ordering checks. */
function applyChatEvent(state: ChatState, event: ChatEvent, now: number): ChatState {
	const turnId = state.currentTurnId;
	switch (event.type) {
		case "snapshot":
			return applySnapshot(state, event, now);
		case "turn.started":
			return startTurn(state, event);
		case "turn.finished":
			return finishTurn(state, event);
		case "text.delta":
			return appendText(state, event, now);
		case "message":
			return applyMessage(state, event, now);
		case "tool.started":
			return startTool(state, event, now);
		case "tool.output": {
			const items = replaceItem(state.items, `tool:${event.id}`, (item) =>
				item.kind === "tool" ? { ...item, output: [...item.output, event.part] } : item,
			);
			return items ? { ...state, items } : state;
		}
		case "tool.finished": {
			const items = replaceItem(state.items, `tool:${event.id}`, (item) =>
				item.kind === "tool"
					? { ...item, status: event.isError ? "error" : "done" }
					: item,
			);
			return items ? { ...state, items } : state;
		}
		case "permission.requested": {
			const { type: _type, sessionId: _session, seq: _seq, ...card } = event;
			return { ...state, cards: addCard(state.cards, { type: "permission", ...card }) };
		}
		case "question.requested": {
			const { type: _type, sessionId: _session, seq: _seq, ...card } = event;
			return { ...state, cards: addCard(state.cards, { type: "question", ...card }) };
		}
		case "card.resolved":
			return resolveCard(state, event);
		case "error":
			return {
				...state,
				lastError: { seq: event.seq, message: event.message },
				items: [
					...state.items,
					{ kind: "error", key: `error:${event.seq}`, message: event.message, turnId },
				],
			};
		case "settings":
			return {
				...state,
				settings: {
					agent: event.agent,
					model: event.model,
					effort: event.effort,
					mode: event.mode,
				},
			};
		case "models":
			return { ...state, models: event.models };
		case "modes":
			return { ...state, modes: event.modes };
		case "mcp":
			return { ...state, mcp: event.servers };
		case "rules":
			return { ...state, sessionRules: event.rules };
		case "signIn":
			return { ...state, signIn: event.state, signInChecking: false };
		case "shell": {
			const { type: _type, sessionId: _session, seq: _seq, ...fields } = event;
			const key = `shell:${event.id}`;
			// Its end, or a replay of a command already shown, updates it in place.
			const item: ChatShellItem = { kind: "shell", key, turnId: null, ...fields };
			const items = replaceItem(state.items, key, () => item);
			return { ...state, items: items ?? [...state.items, item] };
		}
		case "commands":
			return { ...state, commands: event.commands };
		case "context":
			return { ...state, context: contextUsage(event, now) };
		case "handoff": {
			const item: ChatHandoffItem = {
				kind: "handoff",
				key: `handoff:${event.seq}`,
				from: event.from,
				to: event.to,
				droppedTurns: event.droppedTurns,
				failed: event.failed === true,
				turnId: null,
			};
			return { ...state, items: [...state.items, item] };
		}
	}
}

/** A turn began; an estimated turn already open becomes this one. */
function startTurn(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "turn.started" }>,
): ChatState {
	const turnId = state.currentTurnId;
	const open = turnId === null ? undefined : state.turns[turnId];
	const id = open?.estimated ? open.id : `turn-${event.seq}`;
	return {
		...state,
		currentTurnId: id,
		pendingSplit: null,
		turns: {
			...state.turns,
			[id]: {
				id,
				startedAt: event.at,
				finishedAt: null,
				status: "running",
				estimated: false,
			},
		},
	};
}

/** The turn ended: its streaming text stops and its running tools take the turn's outcome. */
function finishTurn(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "turn.finished" }>,
): ChatState {
	const turnId = state.currentTurnId;
	if (turnId === null) return state;
	const turn = state.turns[turnId];
	const left = TOOL_LEFT_RUNNING[event.status];
	return {
		...state,
		currentTurnId: null,
		pendingSplit: null,
		turns: turn
			? {
					...state.turns,
					[turnId]: { ...turn, finishedAt: event.at, status: event.status },
				}
			: state.turns,
		items: state.items.map((item) => {
			if (item.kind === "message" && item.streaming)
				return { ...item, streaming: false };
			if (item.kind === "tool" && item.status === "running")
				return { ...item, status: left };
			return item;
		}),
	};
}

/** More of an assistant message: added to it, or a new message when it is the first part. */
function appendText(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "text.delta" }>,
	now: number,
): ChatState {
	const key = `message:${event.messageId}`;
	const items = replaceItem(state.items, key, (item) =>
		item.kind === "message" ? { ...item, markdown: item.markdown + event.text } : item,
	);
	if (items) return { ...state, items };
	const split = takeInSentMessage(state, now);
	return {
		...split,
		items: [
			...split.items,
			{
				kind: "message",
				key,
				id: event.messageId,
				role: "assistant",
				markdown: event.text,
				attachments: [],
				streaming: true,
				turnId: split.currentTurnId,
			},
		],
	};
}

/** A whole message: it replaces a streamed one, or joins the conversation. */
function applyMessage(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "message" }>,
	now: number,
): ChatState {
	const key = `message:${event.id}`;
	const fields = {
		markdown: event.markdown,
		attachments: event.attachments ?? [],
		streaming: false,
	};
	const items = replaceItem(state.items, key, (item) =>
		item.kind === "message" ? { ...item, ...fields } : item,
	);
	const lastUserMessageSeq =
		event.role === "user" ? event.seq : state.lastUserMessageSeq;
	if (items) return { ...state, items, lastUserMessageSeq };
	if (event.role === "user" && isWorking(state)) {
		return sentWhileWorking(state, { ...fields, id: event.id }, event.seq);
	}
	const split = event.role === "user" ? state : takeInSentMessage(state, now);
	return {
		...split,
		lastUserMessageSeq,
		items: [
			...split.items,
			{
				kind: "message",
				key,
				id: event.id,
				role: event.role,
				...fields,
				// What the student wrote is never folded into a turn's work.
				turnId: event.role === "user" ? null : split.currentTurnId,
			},
		],
	};
}

/** A tool call began, or a held live event repeats a replayed one; it takes any decision already known. */
function startTool(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "tool.started" }>,
	now: number,
): ChatState {
	const key = `tool:${event.id}`;
	const decision = state.decisions[event.id];
	const fields = {
		name: event.name,
		title: event.title,
		input: event.input,
		...(decision ? { decision } : {}),
	};
	// A held live event can repeat a replayed one; it updates, never doubles.
	const items = replaceItem(state.items, key, (item) =>
		item.kind === "tool" ? { ...item, ...fields } : item,
	);
	if (items) return { ...state, items };
	const split = takeInSentMessage(state, now);
	return {
		...split,
		items: [
			...split.items,
			{
				kind: "tool",
				key,
				id: event.id,
				...fields,
				output: [],
				status: "running",
				turnId: split.currentTurnId,
			},
		],
	};
}

/**
 * A card closed. An answered permission card's decision is kept by its tool
 * call's id, which is the card's own, and set on the call if it has arrived.
 */
function resolveCard(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "card.resolved" }>,
): ChatState {
	const cards = state.cards.filter((card) => card.id !== event.id);
	const { decision } = event;
	if (decision === undefined) return { ...state, cards };
	const items = replaceItem(state.items, `tool:${event.id}`, (item) =>
		item.kind === "tool" ? { ...item, decision } : item,
	);
	return {
		...state,
		cards,
		decisions: { ...state.decisions, [event.id]: decision },
		items: items ?? state.items,
	};
}

/** The figures as the meter reads them, with the host's clock skew measured on arrival. */
function contextUsage(
	event: Extract<ChatServerEvent, { type: "context" }>,
	now: number,
): ChatContextUsage {
	return {
		usedTokens: event.usedTokens,
		windowTokens: event.windowTokens,
		cache: event.cache,
		clockOffsetMs: event.now === undefined ? 0 : now - event.now,
	};
}

/** A turn is running and has already shown some work. */
function isWorking(state: ChatState): boolean {
	const turnId = state.currentTurnId;
	if (turnId === null || state.turns[turnId]?.status !== "running") return false;
	return state.items.some((item) => item.turnId === turnId);
}

/**
 * A message the student sent while Claude worked (SPEC.md §10.8). It shows at
 * once, but the turn goes on until Claude takes it in at its next step, so a
 * tool still running stays on the Working line.
 */
function sentWhileWorking(
	state: ChatState,
	message: Pick<ChatMessageItem, "id" | "markdown" | "attachments">,
	seq: number,
): ChatState {
	return {
		...state,
		lastUserMessageSeq: seq,
		pendingSplit: state.pendingSplit ?? seq,
		items: [
			...state.items,
			{
				kind: "message",
				key: `message:${message.id}`,
				role: "user",
				streaming: false,
				turnId: null,
				whileWorking: true,
				...message,
			},
		],
	};
}

/**
 * Claude's next step after a sent-while-working message: the work so far is
 * done, and what follows is a new turn below the message, as a reload replays
 * it from the transcript. If the turn ends first, `turn.finished` drops the
 * split, so its end state lands on the work it describes.
 */
function takeInSentMessage(state: ChatState, now: number): ChatState {
	const before = state.currentTurnId;
	if (state.pendingSplit === null || before === null) return state;
	const turn = state.turns[before] as ChatTurn;
	const next = `turn-${state.pendingSplit}`;
	return {
		...state,
		pendingSplit: null,
		currentTurnId: next,
		turns: {
			...state.turns,
			[before]: { ...turn, finishedAt: now, status: "done" },
			[next]: {
				id: next,
				startedAt: now,
				finishedAt: null,
				status: "running",
				estimated: false,
			},
		},
	};
}

/** Session rules are letting some tools run without a card. */
export function selectSessionRulesActive(state: ChatState): boolean {
	return state.sessionRules.length > 0;
}

/** Nothing has been said or run in the chat. */
export function isEmptyChat(state: ChatState): boolean {
	return (
		state.loaded && state.items.length === 0 && Object.keys(state.turns).length === 0
	);
}

/**
 * A chat nobody has used yet: no turn has run and, for Claude Code, the host
 * still reports its start values, so the last-used settings may be applied
 * (SPEC.md §10.8). Codex starts at the student's own Codex defaults, which
 * the web cannot know, so an empty Codex chat counts as new.
 */
export function isNewChat(state: ChatState): boolean {
	const { settings } = state;
	if (!isEmptyChat(state) || settings === null) return false;
	if (settings.agent !== "claude") return true;
	return (
		settings.model === CHAT_START_SETTINGS.model &&
		settings.effort === CHAT_START_SETTINGS.effort &&
		settings.mode === chatStartMode(state.models, settings.model)
	);
}

/** What a tool still running becomes when its turn ends. */
const TOOL_LEFT_RUNNING: Record<
	Extract<ChatServerEvent, { type: "turn.finished" }>["status"],
	ChatToolItem["status"]
> = { done: "done", interrupted: "stopped", error: "stopped" };

function addCard(cards: ChatOpenCard[], card: ChatOpenCard): ChatOpenCard[] {
	return cards.some((open) => open.id === card.id) ? cards : [...cards, card];
}

/** What the store hands a message to; false when the socket is not open. */
export type ChatTransport = (message: ChatClientMessage) => boolean;

/**
 * The chat store's public API, which the composer builds on.
 *
 * Read state with `useStore(store, selector)` from zustand, selecting a
 * single field: `settings` for the pickers, `currentTurnId !== null` for
 * whether a turn is running, `connection` for whether sending can work.
 *
 * Every action validates its message against `ChatClientMessage` and
 * returns false, sending nothing, when it is invalid or the socket is not
 * open. The conversation updates only when the server echoes the result,
 * so a `send` shows up as a user `message` event, never optimistically.
 */
interface ChatActions {
	/** Start a turn, or queue it behind the running one. Attachments are project-relative paths. */
	send: (text: string, attachments: ChatAttachment[]) => boolean;
	/** Change the model, effort or permission mode for the next turns. */
	set: (settings: {
		model?: string;
		effort?: ChatEffort;
		mode?: ChatPermissionMode;
	}) => boolean;
	/** Stop the running turn. */
	interrupt: () => boolean;
	/** Answer a question card; answers and notes are keyed by question text. */
	answerQuestion: (
		id: string,
		answers: Record<string, string>,
		notes?: Record<string, string>,
	) => boolean;
	answerPermission: (
		id: string,
		optionId: string,
		extras?: { message?: string },
	) => boolean;
	/** Take back a session rule; the list updates when the host confirms. */
	revokeRule: (rule: string) => boolean;
	/** Ask for a subagent's conversation as `subagentFrame`s; a new watch replaces the last. */
	watchSubagent: (toolUseId: string) => boolean;
	unwatchSubagent: (toolUseId: string) => boolean;
	/** Ask the host to check the student's sign-in again; a `signIn` event answers. */
	checkSignIn: () => boolean;
	/** The socket's events, which `useChatSession` wires up. */
	receive: (data: unknown) => void;
	setConnection: (connection: ChatConnection) => void;
}

export type ChatStore = StoreApi<ChatState & ChatActions>;

export function createChatStore(
	transport: ChatTransport,
	clock: () => number = Date.now,
): ChatStore {
	function deliver(message: unknown): boolean {
		const parsed = ChatClientMessage.safeParse(message);
		return parsed.success ? transport(parsed.data) : false;
	}
	return createStore<ChatState & ChatActions>()((set) => ({
		...initialChatState,
		send: (text, attachments) => deliver({ type: "send", text, attachments }),
		set: (settings) => deliver({ type: "set", ...settings }),
		interrupt: () => deliver({ type: "interrupt" }),
		answerQuestion: (id, answers, notes) =>
			deliver({ type: "question.answer", id, answers, ...(notes ? { notes } : {}) }),
		answerPermission: (id, optionId, extras = {}) =>
			deliver({ type: "permission.answer", id, optionId, ...extras }),
		revokeRule: (rule) => deliver({ type: "rule.revoke", rule }),
		watchSubagent: (toolUseId) => deliver({ type: "subagent.watch", toolUseId }),
		unwatchSubagent: (toolUseId) => deliver({ type: "subagent.unwatch", toolUseId }),
		checkSignIn: () => {
			const sent = deliver({ type: "signIn.check" });
			if (sent) set({ signInChecking: true });
			return sent;
		},
		receive: (data) => set((state) => receiveChatFrame(state, data, clock())),
		setConnection: (connection) =>
			set(
				connection === "open"
					? // A new socket starts with a snapshot of its own.
						{ connection, awaitingSnapshot: true }
					: { connection },
			),
	}));
}
