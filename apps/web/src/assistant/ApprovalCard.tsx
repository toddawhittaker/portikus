/**
 * An assistant tool call waiting for a person's approval. Everything shown
 * is drawn from the card's own fields, which the server builds from the
 * catalog entry and the inputs, never from the model's words about what it
 * is about to do. Approve or Deny only; a destructive card stays locked
 * until its confirmation text is typed exactly, as the server checks again.
 */
import type { ChatCardDecision, ChatOpenCard } from "@portikus/contracts";
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

/** The inputs the operation will run with, one row per field. The one place a card's inputs are drawn, so a batch card's rows belong here too. */
function ApprovalInputs({ card }: { card: ApprovalCardData }) {
	const { input } = card;
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
	/** Put focus on the card's first control as it appears. */
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
	const body = useRef<HTMLElement | null>(null);
	const [typed, setTyped] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState("");
	const destructive = card.risk === "destructive";
	const confirmText = destructive ? card.confirmText : undefined;
	const { approve, deny } = approvalOptions(card);
	const locked = destructive && (confirmText === undefined || typed !== confirmText);
	const resolved = decision !== undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (!autoFocus || resolved) return;
		body.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus();
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
			ref={body}
			className="pk-assistant-card"
			aria-labelledby={titleId}
			data-testid="approval-card"
			data-risk={card.risk ?? "change"}
			data-decision={decision}
		>
			<header className="pk-assistant-card-head">
				<h3 id={titleId} className="pk-assistant-card-title">
					{approvalTitle(card)}
				</h3>
				<Badge tone={destructive ? "danger" : "warning"} data-testid="approval-risk">
					{destructive ? "Destructive" : "Change"}
				</Badge>
			</header>
			<p className="pk-assistant-card-op">
				Operation <code className="pk-mono-body">{card.toolName}</code>
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
					{destructive ? (
						<TextField
							id={typedId}
							label={
								<>
									Type <span className="font-mono">{confirmText}</span> to approve
								</>
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
							disabled={locked || !approve}
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
