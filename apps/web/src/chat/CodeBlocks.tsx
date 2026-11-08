/**
 * Literal text in the conversation and on cards: tool output, a command, a
 * file's content and an edit as a diff. Long text is cut short behind a
 * "Show all" button so one tool call never buries the reply it led to.
 */
import { Button } from "@portikus/ui";
import { useState } from "react";
import { CopyButton } from "./CopyButton.js";
import { type DiffLine, diffLines, type EditChange, previewText } from "./toolView.js";

function MoreButton({
	hidden,
	open,
	onToggle,
}: {
	hidden: number;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<Button
			variant="quiet"
			size="sm"
			className="pk-chat-more"
			aria-expanded={open}
			onClick={onToggle}
		>
			{open ? "Show less" : `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`}
		</Button>
	);
}

/** A plain block of text, cut to `limit` lines until opened; a copy copies all of it. */
export function CodeBlock({
	text,
	limit,
	className = "",
	testId,
	copyLabel,
}: {
	text: string;
	limit?: number;
	className?: string;
	testId?: string;
	/** Names a copy button for the whole text; without it there is none. */
	copyLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const preview = previewText(text, limit);
	return (
		<div className={`pk-chat-codeblock${copyLabel ? " pk-chat-copy-host" : ""}`}>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
			<pre className={`pk-chat-code ${className}`} tabIndex={0} data-testid={testId}>
				{open ? text : preview.shown}
			</pre>
			{copyLabel ? <CopyButton label={copyLabel} text={text} /> : null}
			{preview.hidden > 0 ? (
				<MoreButton
					hidden={preview.hidden}
					open={open}
					onToggle={() => setOpen((was) => !was)}
				/>
			) : null}
		</div>
	);
}

const DIFF_MARK: Record<DiffLine["kind"], string> = {
	same: " ",
	removed: "-",
	added: "+",
};
/** A diff shows more lines than plain output before it is cut. */
const DIFF_LIMIT = 30;

/** An edit as removed and added lines; the marks are text, so a screen reader reads them. */
export function DiffBlock({ changes }: { changes: EditChange[] }) {
	const [open, setOpen] = useState(false);
	const lines = changes.flatMap((change, at) => {
		const diff = diffLines(change.before, change.after);
		return at === 0 ? diff : [{ kind: "same" as const, text: "…" }, ...diff];
	});
	const hidden = Math.max(0, lines.length - DIFF_LIMIT);
	const shown = open ? lines : lines.slice(0, DIFF_LIMIT);
	return (
		<div className="pk-chat-codeblock">
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
			<pre className="pk-chat-code pk-chat-diff" tabIndex={0} data-testid="chat-diff">
				{shown.map((line, at) => (
					// Lines are fixed for the card's life, so position is their identity.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<span key={at} className={`pk-chat-diff-line is-${line.kind}`}>
						{`${DIFF_MARK[line.kind]} ${line.text}\n`}
					</span>
				))}
			</pre>
			{hidden > 0 ? (
				<MoreButton
					hidden={hidden}
					open={open}
					onToggle={() => setOpen((was) => !was)}
				/>
			) : null}
		</div>
	);
}
