/**
 * The conversation, oldest first. What the student wrote sits on the right;
 * each of Claude's turns is one entry under a "Claude" byline. A running
 * turn shows its work as it happens and a line naming the step in hand,
 * "Running pnpm build · 3m 43s"; a finished one
 * folds its tool work and middle narration into "Worked for 3m 43s"
 * (SPEC.md §10.8). The list is not a live region: streaming text would be
 * read out word by word, so ChatView announces the turn's state instead.
 */
import { chatImageType } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { memo, useEffect, useState } from "react";
import { displayName } from "../files/paths.js";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CopyButton } from "./CopyButton.js";
import type { ChatItem, ChatMessageItem, ChatToolItem, ChatTurn } from "./chatStore.js";
import { formatElapsed, isoDuration } from "./elapsed.js";
import { foldTurn, groupTools, type ToolRun } from "./fold.js";
import { useChatImages } from "./ImageViewer.js";
import { askedQuestions, readAnswers } from "./questionAnswer.js";
import { ToolBlock } from "./ToolBlock.js";
import { toolLine } from "./toolView.js";
import "./messages.css";
import "./turn.css";

/**
 * Items in order, with each turn's items gathered where the turn begins, and
 * Claude's items outside any turn, as a reloaded history has them, gathered
 * in runs between the student's messages so each run has one byline.
 */
type Entry =
	| { kind: "user"; item: ChatMessageItem }
	| { kind: "turn"; turnId: string; items: ChatItem[] }
	| { kind: "loose"; key: string; items: ChatItem[] };

function groupByTurn(
	items: readonly ChatItem[],
	currentTurnId: string | null,
): Entry[] {
	const entries: Entry[] = [];
	const turns = new Map<string, ChatItem[]>();
	for (const item of items) {
		if (item.kind === "message" && item.role === "user") {
			entries.push({ kind: "user", item });
			continue;
		}
		if (item.turnId === null) {
			const last = entries.at(-1);
			if (last?.kind === "loose") last.items.push(item);
			else entries.push({ kind: "loose", key: item.key, items: [item] });
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

/**
 * A file the student sent. A picture shows as a thumbnail that opens large in
 * the viewer; anything else, or a picture that will not load, is its path.
 */
function SentFile({ path }: { path: string }) {
	const images = useChatImages();
	const [failed, setFailed] = useState(false);
	const name = displayName(path.slice(path.lastIndexOf("/") + 1));
	if (images === null || failed || chatImageType(path) === null) {
		return (
			<li className="pk-chat-attachment">
				<Icon name="file" size="sm" />
				<span className="pk-chat-attachment-name">{displayName(path)}</span>
			</li>
		);
	}
	const src = images.imageUrl(path);
	return (
		<li className="pk-chat-attachment pk-chat-sent-image">
			<button
				type="button"
				className="pk-chat-image pk-chat-thumb"
				aria-label={`View image ${name}`}
				onClick={() => images.open({ src, name, alt: name, projectPath: path })}
			>
				<img
					src={src}
					alt={name}
					width={56}
					height={56}
					loading="lazy"
					onError={() => setFailed(true)}
				/>
			</button>
			<span className="pk-chat-attachment-name" title={displayName(path)}>
				{name}
			</span>
		</li>
	);
}

/** What the student wrote, drawn as the Markdown the composer sent (SPEC.md §10.8). */
function UserMessage({ message }: { message: ChatMessageItem }) {
	return (
		<li
			className="pk-chat-entry pk-chat-entry--user pk-chat-copy-host"
			data-testid="chat-user-message"
		>
			<p className="sr-only">You said:</p>
			{message.markdown !== "" ? (
				<CopyButton label="Copy message" text={message.markdown} />
			) : null}
			<div className="pk-chat-bubble">
				{message.markdown !== "" ? <ChatMarkdown text={message.markdown} /> : null}
				{message.attachments.length > 0 ? (
					<ul className="pk-chat-attachments" aria-label="Attached files">
						{message.attachments.map((file) => (
							<SentFile key={file.path} path={file.path} />
						))}
					</ul>
				) : null}
			</div>
			{message.whileWorking ? (
				<p className="pk-turn-sent-note" data-testid="chat-sent-while-working">
					Sent while Claude was working
				</p>
			) : null}
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
			className="pk-chat-step pk-chat-message pk-chat-copy-host"
			data-testid="chat-assistant-message"
			aria-busy={message.streaming || undefined}
		>
			<ChatMarkdown text={message.markdown} />
			<CopyButton label="Copy message" text={message.markdown} />
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
					{unread ? (
						// One result answers them all, so it is shown once, under every question.
						<div className="pk-chat-asked-item">
							{asked.map((one, at) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: questions never change once asked
								<dt key={at}>{one.question}</dt>
							))}
							<dd>{result}</dd>
						</div>
					) : (
						asked.map((one, at) => (
							// Questions never change once asked.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<div key={at} className="pk-chat-asked-item">
								<dt>{one.question}</dt>
								<dd className={one.answer === null ? "pk-chat-muted" : undefined}>
									{one.answer ??
										(waiting
											? "Not answered yet"
											: tool.status === "done"
												? "Skipped"
												: "Not answered")}
								</dd>
							</div>
						))
					)}
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

/** What a running call is doing, in the words of its row. */
function doingLine(tool: ChatToolItem): string {
	const line = toolLine(tool.name, tool.input, tool.title);
	return line.verb ? `${line.verb.doing} ${line.target}` : `Using ${tool.name}`;
}

/**
 * A run of tool calls under one disclosure, "8 tool calls", with the tools
 * used or, while one runs, what it is doing, and any failures. Each call
 * inside keeps its own row (SPEC.md §10.8).
 */
function ToolGroup({ run }: { run: ToolRun }) {
	const { tools } = run;
	const running = tools.filter((tool) => tool.status === "running").at(-1);
	const failed = tools.filter((tool) => tool.status === "error").length;
	const stopped = tools.filter((tool) => tool.status === "stopped").length;
	const what = running
		? doingLine(running)
		: [...new Set(tools.map((tool) => tool.name))].join(", ");
	const status = running
		? "running"
		: failed > 0
			? "error"
			: stopped > 0
				? "stopped"
				: "done";
	return (
		<li className="pk-chat-step">
			<details
				className="pk-turn-group"
				data-testid="chat-tool-group"
				data-status={status}
			>
				<summary className="pk-chat-worked-summary pk-turn-group-summary pk-focus-inset">
					<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
					<span className="pk-turn-group-count">{tools.length} tool calls</span>
					<span
						className="pk-chat-worked-count pk-turn-group-what"
						data-testid="chat-tool-group-what"
						title={what}
					>
						{what}
					</span>
					{failed > 0 ? (
						<span className="pk-chat-tool-state is-error pk-turn-group-mark">
							<Icon name="alert" size="sm" />
							{failed} failed
						</span>
					) : null}
					{stopped > 0 ? (
						<span className="pk-chat-tool-state is-stopped pk-turn-group-mark">
							<Icon name="stop" size="sm" />
							{stopped} stopped
						</span>
					) : null}
				</summary>
				<ol className="pk-chat-steps pk-chat-worked-log">
					{tools.map((tool) => (
						<li key={tool.key} className="pk-chat-step">
							<ToolBlock tool={tool} />
						</li>
					))}
				</ol>
			</details>
		</li>
	);
}

/** Items in order, each run of tool calls under one group. */
function Steps({ items }: { items: readonly ChatItem[] }) {
	return groupTools(items, isAsked).map((shown) =>
		shown.kind === "tools" ? (
			<ToolGroup key={shown.key} run={shown} />
		) : (
			<Step key={shown.key} item={shown} />
		),
	);
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
					<Steps items={items} />
				</ol>
			</details>
		</li>
	);
}

interface TurnProps {
	turn: ChatTurn | undefined;
	items: ChatItem[];
	/** Tool calls waiting on a permission card, by id. */
	asking: ReadonlySet<string>;
}

function TurnSteps({ turn, items, asking }: TurnProps) {
	if (turn === undefined || turn.status === "running") {
		return (
			<>
				<Steps items={items} />
				{turn ? (
					<Working since={turn.startedAt} doing={doingNow(items, asking)} />
				) : null}
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

function Turn({ turn, items, asking }: TurnProps) {
	return (
		<li className="pk-chat-entry pk-chat-turn" data-testid="chat-turn">
			<p className="pk-chat-author">
				<Icon name="agent" size="sm" />
				Claude
			</p>
			<ol className="pk-chat-steps">
				<TurnSteps turn={turn} items={items} asking={asking} />
			</ol>
		</li>
	);
}

/**
 * The step in hand: the newest running tool, in the words of its row, or a
 * reply being written; null when neither, as between steps.
 */
function doingNow(
	items: readonly ChatItem[],
	asking: ReadonlySet<string>,
): string | null {
	for (let at = items.length - 1; at >= 0; at--) {
		const item = items[at] as ChatItem;
		if (item.kind === "message" && item.streaming) return "Writing a reply";
		if (item.kind !== "tool" || item.status !== "running") continue;
		if (item.name === "AskUserQuestion") return "Waiting for your answer";
		if (asking.has(item.id)) return "Waiting for your permission";
		return doingLine(item);
	}
	return null;
}

/** Ticks once a second; only this line renders as it does. */
function Working({ since, doing }: { since: number; doing: string | null }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const length = now - since;
	return (
		<li className="pk-chat-step">
			<p className="pk-chat-working pk-turn-working" data-testid="chat-working">
				<span className="pk-spin" aria-hidden={true} />
				{doing === null ? (
					"Working "
				) : (
					<>
						<span className="pk-turn-doing" title={doing}>
							{doing}
						</span>
						{" · "}
					</>
				)}
				<time dateTime={isoDuration(length)}>{formatElapsed(length)}</time>
			</p>
		</li>
	);
}

export interface MessageListProps {
	items: ChatItem[];
	turns: Record<string, ChatTurn>;
	currentTurnId: string | null;
	truncated: boolean;
	/** Ids of the tool calls an open permission card is asking about. */
	asking: ReadonlySet<string>;
}

export function MessageList({
	items,
	turns,
	currentTurnId,
	truncated,
	asking,
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
						<Turn
							key={entry.turnId}
							turn={turns[entry.turnId]}
							items={entry.items}
							asking={asking}
						/>
					);
				}
				if (entry.kind === "user") {
					return <UserMessage key={entry.item.key} message={entry.item} />;
				}
				// Claude's words outside a turn still carry its byline.
				return (
					<Turn key={entry.key} turn={undefined} items={entry.items} asking={asking} />
				);
			})}
		</ol>
	);
}
