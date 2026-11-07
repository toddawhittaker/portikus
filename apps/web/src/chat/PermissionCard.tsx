/**
 * Claude asking to use a tool (SPEC.md §10.8): what it wants to do, in the
 * form a student checks fastest (a command as the command, an edit as a
 * diff), and one button per option the agent offers. `ExitPlanMode` carries
 * a plan, which is shown as Markdown.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useEffect, useId, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CodeBlock, DiffBlock } from "./CodeBlocks.js";
import { toolView } from "./toolView.js";
import { waitingText } from "./waiting.js";

type PermissionCardData = Extract<ChatOpenCard, { type: "permission" }>;

export interface PermissionCardProps {
	card: PermissionCardData;
	/** False when the answer could not be sent. */
	onAnswer: (optionId: string) => boolean;
	takeFocus: () => boolean;
	/** Cards waiting behind this one. */
	waiting: number;
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
		return <CodeBlock text={asText(input)} />;
	}
	return (
		<dl className="pk-chat-fields">
			{Object.entries(input).map(([key, value]) => (
				<div key={key} className="pk-chat-field">
					<dt className="pk-chat-label pk-mono-body">{key}</dt>
					<dd>
						<CodeBlock text={asText(value)} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function Body({ card }: { card: PermissionCardData }) {
	const plan = planOf(card);
	if (plan !== null) {
		return (
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
			<div className="pk-chat-plan" tabIndex={0} data-testid="chat-plan">
				<ChatMarkdown text={plan} />
			</div>
		);
	}
	const view = toolView(card.toolName, card.input, card.title);
	switch (view.detail?.kind) {
		case "command":
			return (
				<CodeBlock
					text={view.detail.command}
					className="pk-chat-command"
					testId="chat-permission-command"
				/>
			);
		case "edit":
			return (
				<>
					<p className="pk-chat-card-path pk-mono-body">{view.detail.path}</p>
					<DiffBlock changes={view.detail.changes} />
				</>
			);
		case "write":
			return (
				<>
					<p className="pk-chat-card-path pk-mono-body">{view.detail.path}</p>
					<CodeBlock text={view.detail.content} />
				</>
			);
		default:
			return <ToolInput input={card.input} />;
	}
}

function heading(card: PermissionCardData): string {
	if (planOf(card) !== null) return "Claude has a plan for you to review";
	switch (card.toolName) {
		case "Bash":
			return "Claude wants to run a command";
		case "Edit":
		case "MultiEdit":
			return "Claude wants to edit a file";
		case "Write":
			return "Claude wants to write a file";
		default:
			return `Claude wants to use ${card.toolName}`;
	}
}

export function PermissionCard({
	card,
	onAnswer,
	takeFocus,
	waiting,
}: PermissionCardProps) {
	const titleId = useId();
	const actions = useRef<HTMLDivElement | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState("");
	const title = heading(card);
	// The host's title adds something only when the heading does not already say it.
	const subtitle =
		card.title && !card.title.startsWith(card.toolName) ? card.title : null;

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
				{title}
			</h2>
			{subtitle ? <p className="pk-chat-card-subtitle">{subtitle}</p> : null}
			<Body card={card} />
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
				{waiting > 0 ? (
					<p className="pk-chat-card-waiting" data-testid="chat-cards-waiting">
						{waitingText(waiting)}
					</p>
				) : null}
			</div>
		</section>
	);
}
