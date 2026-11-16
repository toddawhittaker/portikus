/**
 * An assistant tool call waiting for a person's approval. Everything shown
 * is drawn from the card's own fields, which the server builds from the
 * catalog entry and the inputs, never from the model's words about what it
 * is about to do. Approve or Deny only; a destructive card stays locked
 * until its confirmation text is typed exactly, as the server checks again.
 */
import {
	AssistantBatchInput,
	type ChatCardDecision,
	type ChatOpenCard,
} from "@portikus/contracts";
import { Badge, Button, TextField } from "@portikus/ui";
import { useEffect, useId, useRef, useState } from "react";
import "./assistant.css";

export type ApprovalCardData = Extract<ChatOpenCard, { type: "permission" }>;
type Option = ApprovalCardData["options"][number];

/** The card's two answers; an option that would last beyond this call is never offered. */
function approvalOptions(card: ApprovalCardData): {
	approve: Option | undefined;
	deny: Option | undefined;
} {
	const decided = (decision: ChatCardDecision, id: string) =>
		card.options.find((option) =>
			option.decision ? option.decision === decision : option.id === id,
		);
	return { approve: decided("allowed", "allow"), deny: decided("denied", "deny") };
}

/** The heading: the operation's description, or its name when it has none. */
export function approvalTitle(card: ApprovalCardData): string {
	return card.title.trim() || card.toolName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

/** The card's rows when it is a batch: one operation, one input per row. */
function batchOf(card: ApprovalCardData): AssistantBatchInput | null {
	const parsed = AssistantBatchInput.safeParse(card.input);
	return parsed.success ? parsed.data : null;
}

const ROW_PARTS = ["path", "query", "body"] as const;

type Cell = { part: (typeof ROW_PARTS)[number]; name: string; value: unknown };

/** A row's input values as cells: path and query fields, and body fields (a body that is not an object is one cell). */
function rowCells(row: Record<string, unknown>): Cell[] {
	const cells: Cell[] = [];
	for (const part of ROW_PARTS) {
		const value = row[part];
		if (value === undefined || value === null) continue;
		if (isRecord(value)) {
			for (const [name, field] of Object.entries(value)) {
				cells.push({ part, name, value: field });
			}
		} else if (part === "body") {
			cells.push({ part, name: "body", value });
		}
	}
	return cells;
}

/** The columns of a batch, in order of first appearance; a field name used by two parts says which part. */
function batchColumns(cells: Cell[][]): { key: string; label: string }[] {
	const seen = new Map<string, Set<string>>();
	for (const cell of cells.flat()) {
		seen.set(cell.name, (seen.get(cell.name) ?? new Set()).add(cell.part));
	}
	const columns = new Map<string, string>();
	for (const cell of cells.flat()) {
		const key = `${cell.part}:${cell.name}`;
		const label =
			(seen.get(cell.name)?.size ?? 0) > 1 ? `${cell.part}.${cell.name}` : cell.name;
		columns.set(key, label);
	}
	return [...columns].map(([key, label]) => ({ key, label }));
}

/**
 * The rows a batch will run, one table row per call, numbered from 1. The
 * region scrolls after about ten rows and takes the keyboard so its rows can
 * be read without a mouse.
 */
function BatchRows({ batch }: { batch: AssistantBatchInput }) {
	const rows = batch.rows.map(rowCells);
	const columns = batchColumns(rows);
	return (
		<section
			className="pk-assistant-batch"
			aria-label={`Rows for ${batch.operation}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
			tabIndex={0}
		>
			<table className="pk-assistant-inputs" data-testid="approval-batch">
				<caption className="sr-only">
					{batch.rows.length === 1 ? "1 row" : `${batch.rows.length} rows`} for{" "}
					{batch.operation}
				</caption>
				<thead>
					<tr>
						<th scope="col">Row</th>
						{columns.map(({ key, label }) => (
							<th key={key} scope="col" className="pk-mono-body">
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((cells, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
						<tr key={at}>
							<th scope="row">{at + 1}</th>
							{columns.map(({ key }) => {
								const cell = cells.find((c) => `${c.part}:${c.name}` === key);
								return (
									<td key={key}>
										{cell ? (
											<span className="pk-assistant-value">
												{valueText(cell.value)}
											</span>
										) : null}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

/** The inputs the operation will run with, one row per field, or a batch's rows. The one place a card's inputs are drawn. */
function ApprovalInputs({ card }: { card: ApprovalCardData }) {
	const { input } = card;
	const batch = batchOf(card);
	if (batch) return <BatchRows batch={batch} />;
	if (!isRecord(input) || Object.keys(input).length === 0) {
		return isRecord(input) ? (
			<p className="pk-assistant-muted">No inputs</p>
		) : (
			<pre className="pk-assistant-value">{valueText(input)}</pre>
		);
	}
	return (
		<table className="pk-assistant-inputs" data-testid="approval-inputs">
			<caption className="sr-only">Inputs</caption>
			<thead className="sr-only">
				<tr>
					<th scope="col">Field</th>
					<th scope="col">Value</th>
				</tr>
			</thead>
			<tbody>
				{Object.entries(input).map(([key, value]) => (
					<tr key={key}>
						<th scope="row" className="pk-mono-body">
							{key}
						</th>
						<td>
							<span className="pk-assistant-value">{valueText(value)}</span>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

const OUTCOME: Record<ChatCardDecision, string> = {
	allowed: "Approved",
	allowedAlways: "Approved",
	denied: "Denied",
};

export interface ApprovalCardProps {
	card: ApprovalCardData;
	/** False when the answer could not be sent. */
	onAnswer: (optionId: string, confirmation?: string) => boolean;
	/** Set once the card is answered; it then shows the outcome instead of buttons. */
	decision?: ChatCardDecision;
	/** Put focus on the card's heading as it appears, so it is read before its buttons. */
	autoFocus?: boolean;
	/** Cards waiting behind this one. */
	waiting?: number;
}

export function ApprovalCard({
	card,
	onAnswer,
	decision,
	autoFocus = false,
	waiting = 0,
}: ApprovalCardProps) {
	const titleId = useId();
	const typedId = useId();
	const askId = useId();
	const heading = useRef<HTMLHeadingElement | null>(null);
	const [typed, setTyped] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState("");
	const destructive = card.risk === "destructive";
	const batch = batchOf(card);
	// A change batch carries its row count and a destructive batch the operation name as confirmText; a destructive card always asks.
	const mustType = destructive || card.confirmText !== undefined;
	const confirmText = mustType ? card.confirmText : undefined;
	const { approve, deny } = approvalOptions(card);
	const locked = mustType && (confirmText === undefined || typed !== confirmText);
	const resolved = decision !== undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (!autoFocus || resolved) return;
		heading.current?.focus();
	}, []);

	function send(option: Option | undefined, confirmation?: string) {
		if (!option || chosen !== null) return;
		if (!onAnswer(option.id, confirmation)) {
			setError(
				"Your answer was not sent because the assistant is not connected. Wait for it to reconnect, then try again.",
			);
			return;
		}
		setError("");
		setChosen(option.id);
	}

	return (
		<section
			className="pk-assistant-card"
			aria-labelledby={titleId}
			data-testid="approval-card"
			data-risk={card.risk ?? "change"}
			data-decision={decision}
		>
			<header className="pk-assistant-card-head">
				<h3
					id={titleId}
					ref={heading}
					tabIndex={-1}
					className="pk-assistant-card-title"
				>
					{approvalTitle(card)}
				</h3>
				<Badge tone={destructive ? "danger" : "warning"} data-testid="approval-risk">
					{destructive ? "Destructive" : "Change"}
				</Badge>
			</header>
			<p className="pk-assistant-card-op">
				Operation{" "}
				<code className="pk-mono-body">{batch?.operation ?? card.toolName}</code>
				{batch
					? `, ${batch.rows.length === 1 ? "1 row" : `${batch.rows.length} rows`}, run one at a time`
					: null}
			</p>
			<ApprovalInputs card={card} />
			{resolved ? (
				<p className="pk-assistant-outcome" data-testid="approval-outcome">
					{OUTCOME[decision]}
				</p>
			) : (
				<form
					className="pk-assistant-card-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!locked) send(approve, confirmText === undefined ? undefined : typed);
					}}
				>
					{mustType ? (
						<TextField
							id={typedId}
							label={
								<span id={askId}>
									Type <span className="font-mono">{confirmText}</span> to approve
								</span>
							}
							mono
							value={typed}
							autoComplete="off"
							spellCheck={false}
							readOnly={chosen !== null}
							data-testid="approval-confirm"
							onChange={(event) => setTyped(event.target.value)}
						/>
					) : null}
					<p className="pk-assistant-card-error" role="alert">
						{error}
					</p>
					<div className="pk-assistant-card-actions">
						<Button
							type="submit"
							variant={destructive ? "danger" : "primary"}
							// Locked stays focusable and says what unlocks it; the submit handler refuses meanwhile.
							disabled={!approve}
							aria-disabled={locked || undefined}
							aria-describedby={locked ? askId : undefined}
							loading={chosen !== null && chosen === approve?.id}
							data-testid="approval-approve"
						>
							Approve
						</Button>
						<Button
							type="button"
							variant="secondary"
							disabled={!deny}
							loading={chosen !== null && chosen === deny?.id}
							data-testid="approval-deny"
							onClick={() => send(deny)}
						>
							Deny
						</Button>
						{waiting > 0 ? (
							<p className="pk-assistant-muted">
								{waiting === 1 ? "1 more waiting" : `${waiting} more waiting`}
							</p>
						) : null}
					</div>
				</form>
			)}
		</section>
	);
}
