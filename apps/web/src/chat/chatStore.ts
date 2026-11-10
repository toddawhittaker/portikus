/**
 * The state of one chat tab, built from the events on its socket (SPEC.md
 * §10.8). The socket sends a `snapshot` first, then the history as replayed
 * events, then live ones; the store applies them in `seq` order and drops
 * anything stale, malformed, or sent before the snapshot. Nothing here is persisted or logged:
 * the conversation lives in the workspace only (SPEC.md §25.10).
 */
import {
	CHAT_START_EFFORT,
	type ChatAttachment,
	ChatClientMessage,
	type ChatCommand,
	type ChatEffort,
	type ChatLastSettings,
	ChatModelChoice,
	type ChatOpenCard,
	type ChatPermissionMode,
	ChatServerEvent,
	type ChatSessionRule,
	type ChatToolOutputPart,
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
	/** The student sent it while Claude was working; only live, a reload does not know. */
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

export type ChatItem = ChatMessageItem | ChatToolItem | ChatShellItem | ChatErrorItem;

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
	/** The snapshot left out earlier history. */
	truncated: boolean;
	/** The latest `settings` event; null until one arrives. */
	settings: ChatSettings | null;
	/** Rules granted with Always allow that last for this session, as the host reports them. */
	sessionRules: ChatSessionRule[];
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
}

type ChatContextUsage = Pick<
	Extract<ChatServerEvent, { type: "context" }>,
	"usedTokens" | "windowTokens" | "cache"
>;

export const initialChatState: ChatState = {
	connection: "connecting",
	loaded: false,
	items: [],
	turns: {},
	currentTurnId: null,
	pendingSplit: null,
	cards: [],
	truncated: false,
	settings: null,
	sessionRules: [],
	commands: [],
	context: null,
	invalidFrames: 0,
	snapshotAt: 0,
	lastSeq: -1,
	awaitingSnapshot: true,
	lastUserMessageSeq: -1,
	lastError: null,
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
	if (event.type === "snapshot") return applySnapshot(state, event, now);
	// The contract puts the snapshot first, so anything earlier is stale.
	if (state.awaitingSnapshot) return state;
	return applyInOrder(state, event, now);
}

function applyInOrder(
	state: ChatState,
	event: ChatServerEvent,
	now: number,
): ChatState {
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
		// A new snapshot may be a new session; the host sends its context after.
		context: null,
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
function applyChatEvent(
	state: ChatState,
	event: ChatServerEvent,
	now: number,
): ChatState {
	const turnId = state.currentTurnId;
	switch (event.type) {
		case "snapshot":
			return applySnapshot(state, event, now);
		case "turn.started": {
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
		case "turn.finished": {
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
		case "text.delta": {
			const key = `message:${event.messageId}`;
			const items = replaceItem(state.items, key, (item) =>
				item.kind === "message"
					? { ...item, markdown: item.markdown + event.text }
					: item,
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
		case "message": {
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
		case "tool.started": {
			const key = `tool:${event.id}`;
			const fields = { name: event.name, title: event.title, input: event.input };
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
			return { ...state, cards: state.cards.filter((card) => card.id !== event.id) };
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
		case "rules":
			return { ...state, sessionRules: event.rules };
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
			return {
				...state,
				context: {
					usedTokens: event.usedTokens,
					windowTokens: event.windowTokens,
					cache: event.cache,
				},
			};
	}
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

/** The picker entry for the model id the host reports, which may be a full name. */
export function modelChoice(model: string): ChatModelChoice {
	const known = ChatModelChoice.options.find((choice) => choice === model);
	if (known) return known;
	const family = ChatModelChoice.options.find(
		(choice) => choice !== "default" && model.includes(choice),
	);
	return family ?? "default";
}

/**
 * A chat nobody has used yet: no turn has run and the host still reports
 * its start values, so the last-used settings may be applied (SPEC.md §10.8).
 */
export function isNewChat(state: ChatState): boolean {
	const { settings } = state;
	return (
		state.loaded &&
		settings !== null &&
		state.items.length === 0 &&
		Object.keys(state.turns).length === 0 &&
		settings.model === "default" &&
		settings.effort === CHAT_START_EFFORT &&
		settings.mode === "default"
	);
}

/** The values worth keeping from what the host confirmed. */
export function lastSettingsOf(settings: ChatSettings): ChatLastSettings {
	return {
		model: modelChoice(settings.model),
		effort: settings.effort,
		mode: settings.mode,
	};
}

/** The change that brings a new chat to the last-used values; null when there is none. */
export function changeToward(
	settings: ChatSettings,
	last: ChatLastSettings,
): Partial<ChatLastSettings> | null {
	const change: Partial<ChatLastSettings> = {};
	if (modelChoice(settings.model) !== last.model) change.model = last.model;
	if (settings.effort !== last.effort) change.effort = last.effort;
	if (settings.mode !== last.mode) change.mode = last.mode;
	return Object.keys(change).length > 0 ? change : null;
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
		extras?: { message?: string; mode?: "acceptEdits" | "default" },
	) => boolean;
	/** Take back a session rule; the list updates when the host confirms. */
	revokeRule: (rule: string) => boolean;
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
