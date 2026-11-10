/**
 * Literal text in the conversation and on cards: tool output, a command, a
 * file's content and an edit as a diff. Long text is cut short behind a
 * "Show all" button so one tool call never buries the reply it led to.
 */
import { Button } from "@portikus/ui";
import { type ReactNode, useState } from "react";
import { CopyButton } from "./CopyButton.js";
import "./highlight.css";
import {
	type Language,
	languageForPath,
	type Token,
	tokensFor,
	useHighlighter,
} from "./highlight.js";
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

function drawTokens(tokens: Token[]): ReactNode[] {
	return tokens.map((token, at) =>
		token.scope ? (
			// Tokens are fixed for the text's life, so position is their identity.
			// biome-ignore lint/suspicious/noArrayIndexKey: see above
			<span key={at} className={token.scope}>
				{token.text}
			</span>
		) : (
			token.text
		),
	);
}

/**
 * Code in a known language, coloured once the highlighter has loaded and
 * plain until then: the text is the same either way, so nothing moves.
 */
export function HighlightedCode({
	code,
	language,
}: {
	code: string;
	language: Language | null;
}) {
	const highlight = useHighlighter(language !== null);
	const tokens = highlight && language ? tokensFor(highlight, code, language) : null;
	return <>{tokens ? drawTokens(tokens) : code}</>;
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

/**
 * An edit as removed and added lines; the marks are text, so a screen
 * reader reads them. With the file's path, each line is coloured in the
 * file's language, and the language is named above the lines.
 */
export function DiffBlock({ changes, path }: { changes: EditChange[]; path?: string }) {
	const [open, setOpen] = useState(false);
	const language = path ? languageForPath(path) : null;
	const highlight = useHighlighter(language !== null);
	const lines = changes.flatMap((change, at) => {
		const diff = diffLines(change.before, change.after);
		return at === 0 ? diff : [{ kind: "same" as const, text: "…" }, ...diff];
	});
	const hidden = Math.max(0, lines.length - DIFF_LIMIT);
	const shown = open ? lines : lines.slice(0, DIFF_LIMIT);
	return (
		<div className="pk-chat-codeblock pk-chat-hl">
			{language ? <span className="pk-chat-lang">{language.label}</span> : null}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
			<pre className="pk-chat-code pk-chat-diff" tabIndex={0} data-testid="chat-diff">
				{shown.map((line, at) => {
					const tokens =
						highlight && language ? tokensFor(highlight, line.text, language) : null;
					return (
						// Lines are fixed for the card's life, so position is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<span key={at} className={`pk-chat-diff-line is-${line.kind}`}>
							{`${DIFF_MARK[line.kind]} `}
							{tokens ? drawTokens(tokens) : line.text}
							{"\n"}
						</span>
					);
				})}
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
