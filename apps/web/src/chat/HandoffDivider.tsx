/**
 * The divider an agent swap leaves in the conversation, and the speaker of
 * each stretch of a chat that swapped, so earlier turns keep the byline of
 * the agent that wrote them (SPEC.md §10.8).
 */
import type { CodingAgent } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { createContext, type ReactNode, useContext } from "react";
import { CODING_AGENT_NAME } from "../agents/codingAgentName.js";
import { ChatAgentContext } from "./chatAgent.js";
import type { ChatHandoffItem, ChatItem } from "./chatStore.js";
import type { ChatFreshStartItem } from "./freshStart.js";
import "./handoff.css";

/**
 * Where the chat changed agents (SPEC.md §10.8). It says what the new agent
 * was given, and when the oldest turns did not fit its context window. When
 * the handoff failed, in the warning colour and icon as a risky choice has,
 * it says the new agent started without the earlier conversation.
 */
export function HandoffDivider({
	handoff,
}: {
	handoff: ChatHandoffItem | ChatFreshStartItem;
}) {
	if (handoff.kind === "freshStart") return <FreshStartDivider fresh={handoff} />;
	const from = CODING_AGENT_NAME[handoff.from];
	const to = CODING_AGENT_NAME[handoff.to];
	const dropped = handoff.droppedTurns;
	if (handoff.failed) {
		return (
			<li
				className="pk-chat-entry pk-chat-handoff is-failed"
				data-testid="chat-handoff"
			>
				<p className="pk-text-caption">
					<Icon name="alert" size="sm" />
					<span>
						Switched from {from} to {to}. {to} started fresh, but the earlier
						conversation could not be passed to it.
					</span>
				</p>
			</li>
		);
	}
	return (
		<li className="pk-chat-entry pk-chat-handoff" data-testid="chat-handoff">
			<p className="pk-chat-muted pk-text-caption">
				Switched from {from} to {to}. {to} started fresh with this conversation as
				context.
				{dropped > 0
					? ` The ${dropped === 1 ? "oldest turn" : `${dropped} oldest turns`} did not fit ${to}\u2019s context window and ${dropped === 1 ? "was" : "were"} left out.`
					: null}
			</p>
		</li>
	);
}

/** What a fresh start's divider can do; null where the chat cannot open files or send. */
export interface FreshStartActions {
	/** Open the note in the editor. */
	openNote: ((path: string) => void) | null;
	/** Send a failed fresh start's first message again; false when it could not be sent. */
	resend: (id: string) => boolean;
	/** Start fresh from an automatic note, named by its notice. */
	startFresh: (id: string) => boolean;
}

export const FreshStartContext = createContext<FreshStartActions | null>(null);

/**
 * Where the chat started fresh from a handoff note (SPEC.md §10.8), with a
 * link that opens the note. When the new conversation's first message
 * failed, it says so in the warning look and offers to send it again.
 */
function FreshStartDivider({ fresh }: { fresh: ChatFreshStartItem }) {
	const actions = useContext(FreshStartContext);
	const openNote = actions?.openNote ?? null;
	return (
		<li
			className={`pk-chat-entry pk-chat-handoff${fresh.failed ? " is-failed" : ""}`}
			data-testid="chat-fresh-start"
		>
			<p className={`pk-text-caption${fresh.failed ? "" : " pk-chat-muted"}`}>
				{fresh.failed ? <Icon name="alert" size="sm" /> : null}
				<span>
					Fresh start from handoff.{" "}
					{fresh.failed ? "The note did not reach the new conversation. " : null}
					{openNote ? (
						<button
							type="button"
							className="pk-chat-handoff-link pk-link"
							data-testid="chat-fresh-start-note"
							onClick={() => openNote(fresh.path)}
						>
							Open the note
						</button>
					) : (
						<code>{fresh.path}</code>
					)}
				</span>
			</p>
			{fresh.failed && actions ? (
				<Button
					size="sm"
					variant="secondary"
					data-testid="chat-fresh-start-resend"
					onClick={() => actions.resend(fresh.id)}
				>
					Send the handoff again
				</Button>
			) : null}
		</li>
	);
}

/**
 * Who spoke in each stretch of the chat: before the first swap, the agent it
 * began with; after each, the agent swapped in. Null for a chat that never
 * swapped, whose speaker is the chat's own agent.
 */
export function firstSpeaker(items: readonly ChatItem[]): CodingAgent | null {
	const first = items.find((item) => item.kind === "handoff");
	return first?.kind === "handoff" ? first.from : null;
}

export function spokenBy(
	speaker: CodingAgent | null,
	key: string,
	node: ReactNode,
): ReactNode {
	return speaker === null ? (
		node
	) : (
		<ChatAgentContext.Provider key={key} value={speaker}>
			{node}
		</ChatAgentContext.Provider>
	);
}
