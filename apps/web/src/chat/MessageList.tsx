/**
 * The conversation, oldest first. A running turn shows its work as it
 * happens and a "Working" line; a finished one folds its tool work and
 * middle narration into "Worked for 3m 43s" (Epic 58 plan, ruling 1).
 * The list is not a live region: streaming text would be read out word by
 * word, so ChatView announces the turn's state instead.
 */
import { Icon } from "@portikus/ui";
import { memo, useEffect, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";
import type { ChatItem, ChatMessageItem, ChatTurn } from "./chatStore.js";
import { formatElapsed, isoDuration } from "./elapsed.js";
import { foldTurn } from "./fold.js";
import { ToolBlock } from "./ToolBlock.js";

/** Items in order, with each turn's items gathered where the turn begins. */
type Entry =
	| { kind: "item"; item: ChatItem }
	| { kind: "turn"; turnId: string; items: ChatItem[] };

export function groupByTurn(items: readonly ChatItem[]): Entry[] {
	const entries: Entry[] = [];
	const turns = new Map<string, ChatItem[]>();
	for (const item of items) {
		if (item.turnId === null) {
			entries.push({ kind: "item", item });
			continue;
		}
		const open = turns.get(item.turnId);
		if (open) {
			open.push(item);
			continue;
		}
		const group = [item];
		turns.set(item.turnId, group);
		entries.push({ kind: "turn", turnId: item.turnId, items: group });
	}
	return entries;
}

const Message = memo(function Message({ message }: { message: ChatMessageItem }) {
	if (message.role === "user") {
		return (
			<li className="pk-chat-entry pk-chat-entry--user" data-testid="chat-user-message">
				<p className="sr-only">You said:</p>
				<div className="pk-chat-bubble">
					<p className="pk-chat-user-text">{message.markdown}</p>
					{message.attachments.length > 0 ? (
						<ul className="pk-chat-attachments" aria-label="Attached files">
							{message.attachments.map((file) => (
								<li key={file.path} className="pk-chat-attachment">
									{file.path}
								</li>
							))}
						</ul>
					) : null}
				</div>
			</li>
		);
	}
	return (
		<li
			className="pk-chat-entry"
			data-testid="chat-assistant-message"
			aria-busy={message.streaming || undefined}
		>
			<p className="sr-only">Claude said:</p>
			<ChatMarkdown text={message.markdown} />
		</li>
	);
});

function Item({ item }: { item: ChatItem }) {
	switch (item.kind) {
		case "message":
			return <Message message={item} />;
		case "tool":
			return (
				<li className="pk-chat-entry">
					<ToolBlock tool={item} />
				</li>
			);
		case "error":
			return (
				<li className="pk-chat-entry">
					<p className="pk-chat-error" data-testid="chat-error">
						<Icon name="alert" size="sm" />
						{item.message}
					</p>
				</li>
			);
	}
}

const SUMMARY: Record<Exclude<ChatTurn["status"], "running">, string> = {
	done: "Worked for",
	interrupted: "Stopped after",
	error: "Failed after",
};

function FinishedTurn({ turn, items }: { turn: ChatTurn; items: ChatItem[] }) {
	const { before, folded, after, errors } = foldTurn(items);
	const length = (turn.finishedAt ?? turn.startedAt) - turn.startedAt;
	const status = turn.status === "running" ? "done" : turn.status;
	return (
		<>
			{before ? <Message message={before} /> : null}
			{folded.length > 0 ? (
				<li className="pk-chat-entry">
					<details className="pk-chat-worked" data-testid="chat-worked">
						<summary className="pk-chat-worked-summary pk-focus-ring">
							<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
							{SUMMARY[status]}{" "}
							<time dateTime={isoDuration(length)}>{formatElapsed(length)}</time>
						</summary>
						<ol className="pk-chat-log pk-chat-worked-log">
							{folded.map((item) => (
								<Item key={item.key} item={item} />
							))}
						</ol>
					</details>
				</li>
			) : null}
			{after ? <Message message={after} /> : null}
			{errors.map((item) => (
				<Item key={item.key} item={item} />
			))}
		</>
	);
}

/** Ticks once a second; only this line renders as it does. */
function Working({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const length = now - since;
	return (
		<li className="pk-chat-entry">
			<p className="pk-chat-working" data-testid="chat-working">
				<span className="pk-spin" aria-hidden={true} />
				Working <time dateTime={isoDuration(length)}>{formatElapsed(length)}</time>
			</p>
		</li>
	);
}

export interface MessageListProps {
	items: ChatItem[];
	turns: Record<string, ChatTurn>;
	currentTurnId: string | null;
	truncated: boolean;
}

export function MessageList({
	items,
	turns,
	currentTurnId,
	truncated,
}: MessageListProps) {
	const current = currentTurnId === null ? undefined : turns[currentTurnId];
	return (
		<ol className="pk-chat-log" aria-label="Conversation">
			{truncated ? (
				<li className="pk-chat-entry">
					<p className="pk-chat-muted pk-chat-truncated">
						Earlier messages are not shown
					</p>
				</li>
			) : null}
			{groupByTurn(items).map((entry) => {
				if (entry.kind === "item")
					return <Item key={entry.item.key} item={entry.item} />;
				const turn = turns[entry.turnId];
				if (turn === undefined || turn.status === "running") {
					return entry.items.map((item) => <Item key={item.key} item={item} />);
				}
				return <FinishedTurn key={entry.turnId} turn={turn} items={entry.items} />;
			})}
			{current ? <Working since={current.startedAt} /> : null}
		</ol>
	);
}
