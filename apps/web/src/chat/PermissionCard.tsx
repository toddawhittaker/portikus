/**
 * Claude asking to use a tool (SPEC.md §10.8): what it wants to
 * run, in a readable form, and one button per option the agent offers.
 * `ExitPlanMode` carries a plan, which is shown as Markdown.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useEffect, useId, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";

type PermissionCardData = Extract<ChatOpenCard, { type: "permission" }>;

export interface PermissionCardProps {
	card: PermissionCardData;
	/** False when the answer could not be sent. */
	onAnswer: (optionId: string) => boolean;
	takeFocus: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function planOf(card: PermissionCardData): string | null {
	if (card.toolName !== "ExitPlanMode" || !isRecord(card.input)) return null;
	return typeof card.input.plan === "string" ? card.input.plan : null;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

/** Top-level fields as label and value; anything else as JSON. */
function ToolInput({ input }: { input: unknown }) {
	if (!isRecord(input) || Object.keys(input).length === 0) {
		return (
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
			<pre className="pk-chat-code" tabIndex={0}>
				{asText(input)}
			</pre>
		);
	}
	return (
		<dl className="pk-chat-fields">
			{Object.entries(input).map(([key, value]) => (
				<div key={key} className="pk-chat-field">
					<dt className="pk-text-label pk-chat-label">{key}</dt>
					<dd>
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
						<pre className="pk-chat-code" tabIndex={0}>
							{asText(value)}
						</pre>
					</dd>
				</div>
			))}
		</dl>
	);
}

export function PermissionCard({ card, onAnswer, takeFocus }: PermissionCardProps) {
	const titleId = useId();
	const actions = useRef<HTMLDivElement | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState("");
	const plan = planOf(card);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (takeFocus()) actions.current?.querySelector<HTMLElement>("button")?.focus();
	}, []);

	function choose(optionId: string) {
		if (chosen !== null) return;
		if (!onAnswer(optionId)) {
			setError(
				"Your answer was not sent because the chat is not connected. Wait for it to reconnect, then try again.",
			);
			return;
		}
		setError("");
		setChosen(optionId);
	}

	return (
		<section
			className="pk-chat-card"
			aria-labelledby={titleId}
			data-testid="chat-permission-card"
		>
			<h2 id={titleId} className="pk-text-heading">
				{plan !== null
					? "Claude has a plan for you to review"
					: `Claude wants to use ${card.toolName}`}
			</h2>
			{card.title ? <p className="pk-chat-card-subtitle">{card.title}</p> : null}
			{plan !== null ? (
				<div className="pk-chat-plan">
					<ChatMarkdown text={plan} />
				</div>
			) : (
				<ToolInput input={card.input} />
			)}
			<p className="pk-chat-card-error" role="alert">
				{error}
			</p>
			<div ref={actions} className="pk-chat-card-actions">
				{card.options.map((option, at) => (
					<Button
						key={option.id}
						variant={at === 0 ? "primary" : "secondary"}
						loading={chosen === option.id}
						aria-disabled={chosen !== null && chosen !== option.id ? true : undefined}
						data-testid={`chat-permission-${option.id}`}
						onClick={() => choose(option.id)}
					>
						{option.label}
					</Button>
				))}
			</div>
		</section>
	);
}
