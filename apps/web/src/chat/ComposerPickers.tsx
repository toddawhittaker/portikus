/**
 * The agent, model, effort and permission pickers along the composer's
 * bottom edge (SPEC.md §10.8). They show what the host last reported in a
 * `settings` event and change it by asking. While a change waits for the
 * host the picker shows the value asked for; a refused change goes back and
 * is announced. A value other than the start value is set in bold, and
 * Bypass permissions carries the warning colour and icon.
 */
import { ChatEffort, ChatPermissionMode } from "@portikus/contracts";
import { Icon, Skeleton } from "@portikus/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatState } from "./chatStore.js";

const MODELS = [
	{ value: "default", label: "Default" },
	{ value: "opus", label: "Opus" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "haiku", label: "Haiku" },
];

const EFFORTS: { value: ChatEffort; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
	{ value: "max", label: "Max" },
];

const MODES: { value: ChatPermissionMode; label: string }[] = [
	{ value: "default", label: "Ask" },
	{ value: "acceptEdits", label: "Accept edits" },
	{ value: "plan", label: "Plan" },
	{ value: "auto", label: "Auto" },
	{ value: "bypassPermissions", label: "Bypass permissions" },
];

/**
 * The values a chat starts with, as the host sets them. The model is left
 * out: the host reports the model Claude chose, so any model may be the start.
 */
const START = { effort: "high", mode: "default" } as const;

export const BYPASS_WARNING =
	"Bypass permissions lets Claude run every tool without asking you first.";

type ChatSettings = NonNullable<ChatState["settings"]>;
type Change = Partial<Pick<ChatSettings, "model" | "effort" | "mode">>;

const LABEL: Record<keyof Change, string> = {
	model: "model",
	effort: "effort",
	mode: "permissions",
};

/** The picker entry for the model id the host reports, which may be a full name. */
function modelChoice(model: string): string {
	const known = MODELS.find((choice) => choice.value === model);
	if (known) return known.value;
	const family = MODELS.find(
		(choice) => choice.value !== "default" && model.includes(choice.value),
	);
	return family?.value ?? "default";
}

interface PickProps {
	label: string;
	testId: string;
	value: string;
	onChoose: (value: string) => void;
	describedBy?: string;
	/** Not the start value, so it is set apart. */
	changed?: boolean;
	warning?: boolean;
	children: ReactNode;
}

function Pick({
	label,
	testId,
	value,
	onChoose,
	describedBy,
	changed = false,
	warning = false,
	children,
}: PickProps) {
	return (
		<label
			className={`pk-pick${changed ? " is-changed" : ""}${warning ? " is-warning" : ""}`}
		>
			<span className="pk-pick-label">{label}</span>
			{warning ? <Icon name="alert" size="sm" className="pk-pick-icon" /> : null}
			<select
				className="pk-pick-select"
				aria-describedby={describedBy}
				data-testid={testId}
				value={value}
				onChange={(event) => onChoose(event.target.value)}
			>
				{children}
			</select>
			<Icon name="chevron-down" size="sm" className="pk-pick-chevron" />
		</label>
	);
}

/** Holds a picker's place, with its label, until the host reports its settings. */
function Waiting({ label }: { label: string }) {
	return (
		<span className="pk-pick is-waiting" data-testid="composer-pick-waiting">
			<span className="pk-pick-label">{label}</span>
			<Skeleton width="3.5rem" />
		</span>
	);
}

interface PickersProps {
	settings: ChatState["settings"];
	lastError: ChatState["lastError"];
	warningId: string;
	/** False when the change could not be sent. */
	onSet: (change: Change) => boolean;
	/** A sentence for the composer's status region. */
	onAnnounce: (text: string) => void;
}

export function ComposerPickers({
	settings,
	lastError,
	warningId,
	onSet,
	onAnnounce,
}: PickersProps) {
	const [pending, setPending] = useState<Change>({});
	const pendingNow = useRef(pending);
	pendingNow.current = pending;
	const errorAtAsk = useRef<number>(-1);

	// The host's report is the truth; it ends any wait.
	useEffect(() => {
		if (settings) setPending({});
	}, [settings]);

	// An error while a change waits means the host refused it.
	useEffect(() => {
		if (!lastError || lastError.seq <= errorAtAsk.current) return;
		const asked = Object.keys(pendingNow.current) as (keyof Change)[];
		if (asked.length === 0) return;
		const what = asked.map((key) => LABEL[key]).join(" and ");
		onAnnounce(`Your ${what} did not change. ${lastError.message}`);
		setPending({});
	}, [lastError, onAnnounce]);

	function ask(change: Change) {
		errorAtAsk.current = lastError?.seq ?? -1;
		if (onSet(change)) setPending((waiting) => ({ ...waiting, ...change }));
	}

	const shown = settings ? { ...settings, ...pending } : null;
	const bypass = shown?.mode === "bypassPermissions";

	return (
		<fieldset className="pk-composer-picks" data-testid="composer-picks">
			<legend className="sr-only">Chat settings</legend>
			<Pick label="Agent" testId="composer-agent" value="claude" onChoose={() => {}}>
				<option value="claude">Claude Code</option>
				<option value="codex" disabled={true}>
					Codex (coming soon)
				</option>
			</Pick>
			{shown ? (
				<>
					<Pick
						label="Model"
						testId="composer-model"
						value={modelChoice(shown.model)}
						onChoose={(model) => ask({ model })}
					>
						{MODELS.map((choice) => (
							<option key={choice.value} value={choice.value}>
								{choice.label}
							</option>
						))}
					</Pick>
					<Pick
						label="Effort"
						testId="composer-effort"
						value={shown.effort}
						changed={shown.effort !== START.effort}
						onChoose={(effort) => ask({ effort: ChatEffort.parse(effort) })}
					>
						{EFFORTS.map((choice) => (
							<option key={choice.value} value={choice.value}>
								{choice.label}
							</option>
						))}
					</Pick>
					<Pick
						label="Permissions"
						testId="composer-mode"
						value={shown.mode}
						changed={shown.mode !== START.mode}
						warning={bypass}
						describedBy={bypass ? warningId : undefined}
						onChoose={(mode) => ask({ mode: ChatPermissionMode.parse(mode) })}
					>
						{MODES.map((choice) => (
							<option key={choice.value} value={choice.value}>
								{choice.label}
							</option>
						))}
					</Pick>
				</>
			) : (
				<>
					<Waiting label="Model" />
					<Waiting label="Effort" />
					<Waiting label="Permissions" />
				</>
			)}
		</fieldset>
	);
}
