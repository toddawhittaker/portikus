/**
 * The agent, model, effort and permission pickers along the composer's
 * bottom edge (SPEC.md §10.8). They show what the host last reported in a
 * `settings` event and change it by asking. While a change waits for the
 * host the picker shows the value asked for; a refused change goes back and
 * is announced. A value other than the start value is set in bold, and
 * Bypass permissions carries the warning colour and icon.
 *
 * Each picker is a menu button with a radio menu, like the New tab menu,
 * so every choice can say what it is for and Bypass can warn before it is
 * chosen (SPEC.md §25.8).
 */
import { CHAT_START_EFFORT, ChatEffort, ChatPermissionMode } from "@portikus/contracts";
import {
	Icon,
	Menu,
	MenuRadioGroup,
	MenuRadioItem,
	MenuRoot,
	MenuTrigger,
	Skeleton,
} from "@portikus/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import {
	type ChatSettings,
	type ChatStore,
	modelChoice,
	selectSessionRulesActive,
} from "./chatStore.js";
import "./pickers.css";

/** Ask with session rules lets some tools run without a card, so the picker says so (SPEC.md §10.8). */
export const ASK_RULES_HINT =
	"Some actions are allowed without asking in this session. See \u201cAllowed without asking in this session\u201d above.";

export const BYPASS_WARNING =
	"Bypass permissions lets Claude run every tool without asking you first.";

interface Choice {
	value: string;
	label: string;
	/** The start of `label` shown alone when the composer is narrow. */
	short?: string;
	description: ReactNode;
	/** Shown but cannot be chosen yet. */
	unavailable?: boolean;
}

const AGENTS: Choice[] = [
	{
		value: "claude",
		label: "Claude Code",
		short: "Claude",
		description: "Anthropic's coding agent.",
	},
	{
		value: "codex",
		label: "Codex",
		description: "Coming soon.",
		unavailable: true,
	},
];

const MODELS: Choice[] = [
	{
		value: "default",
		label: "Default",
		description: "The model Claude Code picks for your account.",
	},
	{
		value: "opus",
		label: "Opus",
		description: "Most capable, for hard problems. Uses your limits fastest.",
	},
	{
		value: "sonnet",
		label: "Sonnet",
		description: "Fast and capable, for most coding.",
	},
	{
		value: "haiku",
		label: "Haiku",
		description: "Fastest, for small, simple changes.",
	},
];

const EFFORTS: Choice[] = [
	{ value: "low", label: "Low", description: "Answers quickly with little thinking." },
	{ value: "medium", label: "Medium", description: "Thinks a little before acting." },
	{
		value: "high",
		label: "High",
		description: "Thinks it through. Slower, uses more.",
	},
	{
		value: "xhigh",
		label: "Extra high",
		description: "Thinks at length. For tricky problems.",
	},
	{
		value: "max",
		label: "Max",
		description: "Thinks the longest. Slowest, uses the most.",
	},
];

const MODES: Choice[] = [
	{
		value: "default",
		label: "Ask",
		description: "Asks before it edits files or runs commands.",
	},
	{
		value: "acceptEdits",
		label: "Accept edits",
		description: "Edits files on its own. Asks before commands.",
	},
	{ value: "plan", label: "Plan", description: "Reads and plans. Changes nothing." },
	{
		value: "auto",
		label: "Auto",
		description: "Runs what it judges safe. Asks about the rest.",
	},
	{
		value: "bypassPermissions",
		label: "Bypass permissions",
		description: (
			<span className="pk-picker-warning">
				<Icon name="alert" size="sm" />
				<span>{BYPASS_WARNING}</span>
			</span>
		),
	},
];

/**
 * The values a chat starts with, as the host sets them. The model is left
 * out: the host reports the model Claude chose, so any model may be the start.
 */
const START = { agent: "claude", effort: CHAT_START_EFFORT, mode: "default" } as const;

type Change = Partial<Pick<ChatSettings, "model" | "effort" | "mode">>;

const LABEL: Record<keyof Change, string> = {
	model: "model",
	effort: "effort",
	mode: "permissions",
};

interface PickProps {
	label: string;
	testId: string;
	value: string;
	choices: Choice[];
	/** The value a chat starts with, marked "Default" in the menu. */
	start?: string;
	onChoose: (value: string) => void;
	describedBy?: string;
	/** Not the start value, so it is set apart. */
	changed?: boolean;
	warning?: boolean;
}

function Pick({
	label,
	testId,
	value,
	choices,
	start,
	onChoose,
	describedBy,
	changed = false,
	warning = false,
}: PickProps) {
	const current = choices.find((choice) => choice.value === value);
	const shown = current?.label ?? value;
	return (
		<MenuRoot>
			<MenuTrigger asChild={true}>
				<button
					type="button"
					className={`pk-picker${changed ? " is-changed" : ""}${warning ? " is-warning" : ""}`}
					aria-describedby={describedBy}
					// A narrow composer hides the prefix word; the tooltip keeps the whole label.
					title={`${label} ${shown}`}
					data-testid={testId}
				>
					{/* The space keeps the name "Model Opus", not "ModelOpus". The narrow
					    form hides words visually only, so the name keeps the prefix (SPEC.md §25.8). */}
					<span className="pk-picker-label">{label}</span>{" "}
					{warning ? <Icon name="alert" size="sm" /> : null}
					<span className="pk-picker-value">
						{current?.short ? (
							<>
								{current.short}
								<span className="pk-picker-more">
									{shown.slice(current.short.length)}
								</span>
							</>
						) : (
							shown
						)}
					</span>
					<Icon name="chevron-down" size="sm" />
				</button>
			</MenuTrigger>
			<Menu label={label} align="start" className="pk-picker-menu">
				<MenuRadioGroup
					label={label}
					value={value}
					// Choosing the value already shown asks the host for nothing.
					onValueChange={(next) => {
						if (next !== value) onChoose(next);
					}}
				>
					{choices.map((choice) => (
						<MenuRadioItem
							key={choice.value}
							value={choice.value}
							description={
								// The marker is read as part of the description, not the name: "High", not "High Default".
								choice.value === start ? (
									<>
										<span className="sr-only">Default. </span>
										{choice.description}
									</>
								) : (
									choice.description
								)
							}
							unavailable={choice.unavailable}
							testId={`${testId}-${choice.value}`}
						>
							{choice.label}
							{choice.value === start ? (
								<>
									{" "}
									<span className="pk-picker-default" aria-hidden={true}>
										Default
									</span>
								</>
							) : null}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</Menu>
		</MenuRoot>
	);
}

/** Holds a picker's place, with its label, until the host reports its settings. */
function Waiting({ label }: { label: string }) {
	return (
		<span className="pk-picker is-waiting" data-testid="composer-pick-waiting">
			<span className="pk-picker-label">{label}</span>
			<Skeleton width="3.5rem" />
		</span>
	);
}

interface PickersProps {
	store: ChatStore;
	warningId: string;
	/** False when the change could not be sent. */
	onSet: (change: Change) => boolean;
	/** A sentence for the composer's status region. */
	onAnnounce: (text: string) => void;
}

export function ComposerPickers({ store, warningId, onSet, onAnnounce }: PickersProps) {
	const settings = useStore(store, (state) => state.settings);
	const lastError = useStore(store, (state) => state.lastError);
	const [pending, setPending] = useState<Change>({});
	const pendingNow = useRef(pending);
	pendingNow.current = pending;
	const errorAtAsk = useRef<number>(-1);
	const rulesActive = useStore(store, selectSessionRulesActive);
	const hintId = useId();

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
	// The host's own mode, not one still waiting, decides whether Ask is the whole story.
	const askWithRules = settings?.mode === "default" && rulesActive;

	return (
		<fieldset className="pk-composer-picks" data-testid="composer-picks">
			<legend className="sr-only">Chat settings</legend>
			<Pick
				label="Agent"
				testId="composer-agent"
				value="claude"
				choices={AGENTS}
				start={START.agent}
				onChoose={() => {}}
			/>
			{shown ? (
				<>
					<Pick
						label="Model"
						testId="composer-model"
						value={modelChoice(shown.model)}
						choices={MODELS}
						onChoose={(model) => ask({ model })}
					/>
					<Pick
						label="Effort"
						testId="composer-effort"
						value={shown.effort}
						choices={EFFORTS}
						start={START.effort}
						changed={shown.effort !== START.effort}
						onChoose={(effort) => ask({ effort: ChatEffort.parse(effort) })}
					/>
					<Pick
						label="Permissions"
						testId="composer-mode"
						value={shown.mode}
						choices={MODES}
						start={START.mode}
						changed={shown.mode !== START.mode}
						warning={bypass}
						describedBy={bypass ? warningId : askWithRules ? hintId : undefined}
						onChoose={(mode) => ask({ mode: ChatPermissionMode.parse(mode) })}
					/>
				</>
			) : (
				<>
					<Waiting label="Model" />
					<Waiting label="Effort" />
					<Waiting label="Permissions" />
				</>
			)}
			{askWithRules ? (
				<p id={hintId} className="pk-picker-hint" data-testid="composer-ask-hint">
					{ASK_RULES_HINT}
				</p>
			) : null}
		</fieldset>
	);
}
