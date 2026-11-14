/**
 * The agent asking to use a tool (SPEC.md §10.8): what it wants to do, in the
 * form a student checks fastest (a command as the command, an edit as a
 * diff), and one button per option the agent offers. A card with a `plan`
 * shows it as Markdown. What a button means comes from its `decision`, not
 * from its id.
 *
 * With the keyboard inside the card, 1, 2 and 3 choose its options, each
 * button showing its number. The keys act only inside the card, never from
 * the message box, so typing there cannot grant a permission (SPEC.md §25.8).
 *
 * Deny, and "No, keep planning", first open a one-line field for telling
 * the agent what to do instead. Enter sends it (empty keeps the plain denial);
 * Escape goes back to the buttons. The host reads a plan's mode from the option.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useEffect, useId, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CodeBlock, DiffBlock } from "./CodeBlocks.js";
import { type ChatAgentNames, useChatAgent } from "./chatAgent.js";
import { NeedsInputTag } from "./NeedsInputTag.js";
import { type FileChangeView, mcpCall, toolView } from "./toolView.js";
import { waitingText } from "./waiting.js";
import "./permissions.css";
import "./turn.css";

type PermissionCardData = Extract<ChatOpenCard, { type: "permission" }>;

export interface PermissionAnswerExtras {
	message?: string;
}

/** An option as the card draws it. */
type Option = PermissionCardData["options"][number];

/**
 * Whether choosing the option denies the call. A host from before buttons
 * carried a decision names it by id.
 */
function isDeny(option: Option): boolean {
	return option.decision ? option.decision === "denied" : option.id === "deny";
}

/** Whether the option lasts beyond this one call, which the card sets apart. */
function isLasting(option: Option): boolean {
	return option.decision ? option.decision === "allowedAlways" : option.id === "always";
}

export interface PermissionCardProps {
	card: PermissionCardData;
	/** False when the answer could not be sent. */
	onAnswer: (optionId: string, extras?: PermissionAnswerExtras) => boolean;
	takeFocus: () => boolean;
	/** Cards waiting behind this one. */
	waiting: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The plan a card asks the student to approve; a host from before `plan` put it in the tool's input. */
function planOf(card: PermissionCardData): string | null {
	if (card.plan !== undefined) return card.plan;
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
	if (mcpCall(card.toolName, card.input) && view.detail === null) {
		return <p className="pk-chat-muted">No arguments</p>;
	}
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
					<DiffBlock changes={view.detail.changes} path={view.detail.path} />
				</>
			);
		case "write":
			return (
				<>
					<p className="pk-chat-card-path pk-mono-body">{view.detail.path}</p>
					<CodeBlock text={view.detail.content} />
				</>
			);
		case "files":
			return view.detail.files.map((file) => (
				<div key={file.path}>
					<p className="pk-chat-card-path pk-mono-body">
						{file.movePath ? `${file.path} \u2192 ${file.movePath}` : file.path}
					</p>
					<DiffBlock lines={file.lines} path={file.movePath ?? file.path} />
				</div>
			));
		case "arguments":
			return <ToolInput input={view.detail.value} />;
		default:
			return <ToolInput input={card.input} />;
	}
}

function heading(card: PermissionCardData, { name }: ChatAgentNames): string {
	if (planOf(card) !== null) return `${name} has a plan for you to review`;
	const mcp = mcpCall(card.toolName, card.input);
	if (mcp) return `Allow ${mcp.server} to run ${mcp.tool}?`;
	const view = toolView(card.toolName, card.input, card.title);
	if (view.detail?.kind === "files")
		return `${name} wants to ${fileChangeWords(view.detail.files)}`;
	switch (card.toolName) {
		case "Bash":
		case "commandExecution":
			return `${name} wants to run a command`;
		case "Edit":
		case "MultiEdit":
			return `${name} wants to edit a file`;
		case "Write":
			return `${name} wants to write a file`;
		default:
			return `${name} wants to use ${card.toolName}`;
	}
}

const FILE_CHANGE_ACTION = {
	add: "create a file",
	delete: "delete a file",
	update: "edit a file",
	move: "move a file",
} as const;

/** What a file-change card asks to do, to one file or to several. */
function fileChangeWords(files: FileChangeView[]): string {
	const [first] = files;
	return files.length === 1 && first
		? FILE_CHANGE_ACTION[first.kind]
		: `change ${files.length} files`;
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
	const [reasonOpen, setReasonOpen] = useState(false);
	const [reason, setReason] = useState("");
	const reasonId = useId();
	const names = useChatAgent();
	const title = heading(card, names);
	const denial = card.options.find(isDeny);
	// The host's title adds something only when the heading does not already say it.
	const subtitle =
		card.title &&
		!card.title.startsWith(card.toolName) &&
		mcpCall(card.toolName, card.input) === null
			? card.title
			: null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (takeFocus()) actions.current?.querySelector<HTMLElement>("button")?.focus();
	}, []);

	function choose(option: Option) {
		if (chosen !== null) return;
		if (isDeny(option)) {
			setReasonOpen(true);
			return;
		}
		send(option.id, {});
	}

	/** Close the reason field and put focus back on the option that opened it. */
	function backToOptions() {
		if (chosen !== null) return;
		setReasonOpen(false);
		setReason("");
		requestAnimationFrame(() =>
			actions.current
				?.querySelector<HTMLElement>(`[data-testid="chat-permission-${denial?.id}"]`)
				?.focus(),
		);
	}

	function send(optionId: string, extras: PermissionAnswerExtras) {
		if (!onAnswer(optionId, extras)) {
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
			onKeyDown={(event) => {
				// Digits typed into the reason field are text, not choices.
				if (reasonOpen) return;
				if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
				const at = Number(event.key) - 1;
				const option = card.options[at];
				if (!option) return;
				event.preventDefault();
				choose(option);
			}}
		>
			<header className="pk-chat-card-head">
				<h2 id={titleId} className="pk-text-heading">
					{title}
				</h2>
				<NeedsInputTag />
			</header>
			{subtitle ? <p className="pk-chat-card-subtitle">{subtitle}</p> : null}
			<Body card={card} />
			<p className="pk-chat-card-error" role="alert">
				{error}
			</p>
			{reasonOpen ? (
				<form
					className="pk-chat-reason"
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						event.stopPropagation();
						backToOptions();
					}}
					onSubmit={(event) => {
						event.preventDefault();
						if (chosen !== null || !denial) return;
						const text = reason.trim();
						send(denial.id, text ? { message: text } : {});
					}}
				>
					<TextField
						id={reasonId}
						label={`Tell ${names.name} what to do instead`}
						hint="Optional. Press Enter to send, Escape to go back."
						value={reason}
						maxLength={2000}
						readOnly={chosen !== null}
						autoFocus
						data-testid="chat-deny-reason"
						onChange={(event) => setReason(event.target.value)}
					/>
					<div className="pk-chat-card-actions">
						<Button
							type="submit"
							variant="primary"
							loading={chosen === denial?.id}
							data-testid="chat-deny-send"
						>
							{reason.trim() ? "Send" : "Deny"}
						</Button>
						{chosen === null ? (
							<Button
								type="button"
								variant="secondary"
								data-testid="chat-deny-back"
								onClick={backToOptions}
							>
								Back
							</Button>
						) : null}
					</div>
				</form>
			) : null}
			<div ref={actions} className="pk-chat-card-actions" hidden={reasonOpen}>
				{card.options.map((option, at) => (
					<Button
						key={option.id}
						variant={at === 0 ? "primary" : "secondary"}
						loading={chosen === option.id}
						aria-disabled={chosen !== null && chosen !== option.id ? true : undefined}
						className={isLasting(option) ? "pk-chat-always" : undefined}
						data-testid={`chat-permission-${option.id}`}
						aria-keyshortcuts={String(at + 1)}
						onClick={() => choose(option)}
					>
						{/* The button's aria-keyshortcuts names the key; the cap is for sight only. */}
						<span className="pk-turn-key" aria-hidden={true}>
							{at + 1}
						</span>
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
