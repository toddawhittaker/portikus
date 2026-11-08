/**
 * The conversation, oldest first. What the student wrote sits on the right;
 * each of Claude's turns is one entry under a "Claude" byline. A running
 * turn shows its work as it happens and a "Working" line; a finished one
 * folds its tool work and middle narration into "Worked for 3m 43s"
 * (SPEC.md §10.8). The list is not a live region: streaming text would be
 * read out word by word, so ChatView announces the turn's state instead.
 */
import { Icon } from "@portikus/ui";
import { memo, useEffect, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";
import type { ChatItem, ChatMessageItem, ChatToolItem, ChatTurn } from "./chatStore.js";
import { formatElapsed, isoDuration } from "./elapsed.js";
import { foldTurn } from "./fold.js";
import { askedQuestions, readAnswers } from "./questionAnswer.js";
import { ToolBlock } from "./ToolBlock.js";

/** Items in order, with each turn's items gathered where the turn begins. */
type Entry =
	| { kind: "item"; item: ChatItem }
	| { kind: "turn"; turnId: string; items: ChatItem[] };

function groupByTurn(
	items: readonly ChatItem[],
	currentTurnId: string | null,
): Entry[] {
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
	// A turn that has only just started still shows its byline and Working line.
	if (currentTurnId !== null && !turns.has(currentTurnId)) {
		entries.push({ kind: "turn", turnId: currentTurnId, items: [] });
	}
	return entries;
}

function UserMessage({ message }: { message: ChatMessageItem }) {
	return (
		<li className="pk-chat-entry pk-chat-entry--user" data-testid="chat-user-message">
			<p className="sr-only">You said:</p>
			<div className="pk-chat-bubble">
				{message.markdown !== "" ? (
					<p className="pk-chat-user-text">{message.markdown}</p>
				) : null}
				{message.attachments.length > 0 ? (
					<ul className="pk-chat-attachments" aria-label="Attached files">
						{message.attachments.map((file) => (
							<li key={file.path} className="pk-chat-attachment">
								<Icon name="file" size="sm" />
								<span className="pk-chat-attachment-name">{file.path}</span>
							</li>
						))}
					</ul>
				) : null}
			</div>
		</li>
	);
}

const AssistantMessage = memo(function AssistantMessage({
	message,
}: {
	message: ChatMessageItem;
}) {
	return (
		<li
			className="pk-chat-step"
			data-testid="chat-assistant-message"
			aria-busy={message.streaming || undefined}
		>
			<ChatMarkdown text={message.markdown} />
		</li>
	);
});

/** An AskUserQuestion call, which the conversation shows as what was asked and answered. */
function isAsked(item: ChatItem): item is ChatToolItem {
	return (
		item.kind === "tool" &&
		item.name === "AskUserQuestion" &&
		askedQuestions(item.input) !== null
	);
}

/**
 * The questions Claude asked, folded to "Asked 2 questions · Answered" and
 * opening to each question with its answer (SPEC.md §10.8). The answers are
 * read from the tool's result, so a reload or another browser shows the same.
 */
function AskedSummary({ tool }: { tool: ChatToolItem }) {
	const questions = askedQuestions(tool.input) ?? [];
	const result = tool.output
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
	// Claude Code writes the result once the student answers; until then the card is open.
	const waiting =
		tool.status === "running" || (tool.status === "done" && result === "");
	const asked = readAnswers(questions, result);
	const answered = asked.some((one) => one.answer !== null);
	// A result in a form not read here is shown as it came, so nothing is lost.
	const unread =
		!waiting && !answered && tool.status === "done" && !/did not answer/i.test(result);
	const outcome = waiting
		? "Needs your input"
		: answered || unread
			? "Answered"
			: tool.status === "done"
				? "Skipped"
				: "Not answered";
	const title =
		questions.length === 1 ? "Asked 1 question" : `Asked ${questions.length} questions`;
	return (
		<li className="pk-chat-step">
			<details className="pk-chat-asked" data-testid="chat-asked">
				<summary className="pk-chat-worked-summary pk-focus-inset">
					<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
					<span>{title}</span>
					<span className="pk-chat-worked-count" data-testid="chat-asked-outcome">
						{outcome}
					</span>
				</summary>
				<dl className="pk-chat-asked-list">
					{asked.map((one, at) => (
						// Questions never change once asked.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<div key={at} className="pk-chat-asked-item">
							<dt>{one.question}</dt>
							<dd className={one.answer === null ? "pk-chat-muted" : undefined}>
								{one.answer ??
									(waiting
										? "Not answered yet"
										: unread
											? result
											: tool.status === "done"
												? "Skipped"
												: "Not answered")}
							</dd>
						</div>
					))}
				</dl>
			</details>
		</li>
	);
}

/** One item inside a turn, or one outside any turn. */
function Step({ item }: { item: ChatItem }) {
	switch (item.kind) {
		case "message":
			return <AssistantMessage message={item} />;
		case "tool":
			if (isAsked(item)) return <AskedSummary tool={item} />;
			return (
				<li className="pk-chat-step">
					<ToolBlock tool={item} />
				</li>
			);
		case "error":
			return (
				<li className="pk-chat-step">
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

function FoldedWork({ turn, items }: { turn: ChatTurn; items: ChatItem[] }) {
	const length = (turn.finishedAt ?? turn.startedAt) - turn.startedAt;
	const status = turn.status === "running" ? "done" : turn.status;
	const tools = items.filter((item) => item.kind === "tool").length;
	return (
		<li className="pk-chat-step">
			<details className="pk-chat-worked" data-testid="chat-worked">
				<summary className="pk-chat-worked-summary pk-focus-inset">
					<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
					<span>
						{SUMMARY[status]}{" "}
						<time dateTime={isoDuration(length)}>{formatElapsed(length)}</time>
					</span>
					{tools > 0 ? (
						<span className="pk-chat-worked-count">
							{tools === 1 ? "1 tool call" : `${tools} tool calls`}
						</span>
					) : null}
				</summary>
				<ol className="pk-chat-steps pk-chat-worked-log">
					{items.map((item) => (
						<Step key={item.key} item={item} />
					))}
				</ol>
			</details>
		</li>
	);
}

function TurnSteps({ turn, items }: { turn: ChatTurn | undefined; items: ChatItem[] }) {
	if (turn === undefined || turn.status === "running") {
		return (
			<>
				{items.map((item) => (
					<Step key={item.key} item={item} />
				))}
				{turn ? <Working since={turn.startedAt} /> : null}
			</>
		);
	}
	// What the student was asked stays in view, after the work and before the reply.
	const asked = items.filter(isAsked);
	const { before, folded, after, errors } = foldTurn(
		items.filter((item) => !isAsked(item)),
	);
	return (
		<>
			{before ? <Step item={before} /> : null}
			{folded.length > 0 ? <FoldedWork turn={turn} items={folded} /> : null}
			{asked.map((item) => (
				<Step key={item.key} item={item} />
			))}
			{after ? <Step item={after} /> : null}
			{errors.map((item) => (
				<Step key={item.key} item={item} />
			))}
		</>
	);
}

function Turn({ turn, items }: { turn: ChatTurn | undefined; items: ChatItem[] }) {
	return (
		<li className="pk-chat-entry pk-chat-turn" data-testid="chat-turn">
			<p className="pk-chat-author">
				<Icon name="agent" size="sm" />
				Claude
			</p>
			<ol className="pk-chat-steps">
				<TurnSteps turn={turn} items={items} />
			</ol>
		</li>
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
		<li className="pk-chat-step">
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
	return (
		<ol className="pk-chat-log" aria-label="Conversation">
			{truncated ? (
				<li className="pk-chat-entry">
					<p className="pk-chat-muted pk-chat-truncated">
						Earlier messages are not shown
					</p>
				</li>
			) : null}
			{groupByTurn(items, currentTurnId).map((entry) => {
				if (entry.kind === "turn") {
					return (
						<Turn key={entry.turnId} turn={turns[entry.turnId]} items={entry.items} />
					);
				}
				const { item } = entry;
				if (item.kind === "message" && item.role === "user") {
					return <UserMessage key={item.key} message={item} />;
				}
				// Claude's words outside a turn still carry its byline.
				return <Turn key={item.key} turn={undefined} items={[item]} />;
			})}
		</ol>
	);
}
