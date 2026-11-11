/**
 * The agent, model, effort and permission pickers (SPEC.md §10.8), kept in
 * one Chat options panel that opens from a button on the composer's bottom
 * edge, so the row holds only attach, the options summary, the microphone,
 * Stop and Send. The pickers show what the host last reported in a
 * `settings` event and change it by asking. While a change waits for the
 * host the picker shows the value asked for; a refused change goes back and
 * is announced. A value other than the start value is set in bold, and
 * Bypass permissions carries the warning colour and icon, on the summary too.
 *
 * The tab's context use and prompt-cache clock take a line under the row
 * (ContextMeter.tsx), so they never move the microphone or Send.
 *
 * Each picker is a menu button with a radio menu, like the New tab menu,
 * so every choice can say what it is for and Bypass can warn before it is
 * chosen (SPEC.md §25.8). The panel is a disclosure, not a menu: it holds
 * those buttons, and their menus portal above it.
 */

import type { ChatModelInfo } from "@portikus/contracts";
import {
	CHAT_START_SETTINGS,
	ChatEffort,
	ChatPermissionMode,
	chatStartMode,
} from "@portikus/contracts";
import {
	Icon,
	Menu,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuRoot,
	MenuTrigger,
	Skeleton,
} from "@portikus/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { isSpeechSupported } from "../voice/speak.js";
import { ContextMeter } from "./ContextMeter.js";
import {
	type ChatSettings,
	type ChatStore,
	selectSessionRulesActive,
} from "./chatStore.js";
import { familyChoices, modelSummary, resolveModel, versionChoices } from "./models.js";
import type { ReadAloud } from "./readAloud.js";
import "./pickers.css";

/** Ask with session rules lets some tools run without a card, so the picker says so (SPEC.md §10.8). */
export const ASK_RULES_HINT =
	"Some actions are allowed without asking in this session. See \u201cAllowed without asking in this session\u201d above.";

export const BYPASS_WARNING =
	"Bypass permissions lets Claude run every tool without asking you first.";

interface Choice {
	value: string;
	label: string;
	description: ReactNode;
	/** Shown but cannot be chosen yet. */
	unavailable?: boolean;
}

const AGENTS: Choice[] = [
	{
		value: "claude",
		label: "Claude Code",
		description: "Anthropic's coding agent.",
	},
	{
		value: "codex",
		label: "Codex",
		description: "Coming soon.",
		unavailable: true,
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
 * out of the menus' "Default" marker, since a model row of that name exists;
 * the start mode is Ask on a model that cannot run Auto.
 */
const START = { agent: "claude", effort: CHAT_START_SETTINGS.effort } as const;

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
					data-testid={testId}
				>
					{/* The space keeps the name "Model Opus", not "ModelOpus". */}
					<span className="pk-picker-label">{label}</span>{" "}
					{warning ? <Icon name="alert" size="sm" /> : null}
					<span className="pk-picker-value">{shown}</span>
					<Icon name="chevron-down" size="sm" />
				</button>
			</MenuTrigger>
			<Menu label={label} align="start" className="pk-picker-menu">
				<MenuLabel>{label}</MenuLabel>
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

/** The "Read replies aloud" switch (ADR 0071), a row of the options panel. */
function ReadAloudSwitch({ readAloud }: { readAloud: ReadAloud }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={readAloud.on}
			className={`pk-picker pk-picker-switch${readAloud.on ? " is-changed" : ""}`}
			data-testid="composer-read-aloud"
			onClick={() => readAloud.set(!readAloud.on)}
		>
			<span className="pk-picker-label">Read replies aloud</span>
			<Icon name="speaker" size="sm" />
			{/* The state is the switch's own; the words are for the eye. */}
			<span className="pk-picker-value" aria-hidden={true}>
				{readAloud.on ? "On" : "Off"}
			</span>
		</button>
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
	readAloud: ReadAloud;
	/** Whether the options panel is showing; the composer opens it for `/model`. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** The short summary on the Options button: agent or model, effort, permissions. */
function summaryOf(shown: ChatSettings, models: ChatModelInfo[]): string {
	const first = modelSummary(models, shown.model);
	const effort = EFFORTS.find((choice) => choice.value === shown.effort)?.label;
	const mode = MODES.find((choice) => choice.value === shown.mode)?.label;
	return [first, effort ?? shown.effort, mode ?? shown.mode].join(" \u00b7 ");
}

export function ComposerPickers({
	store,
	warningId,
	onSet,
	onAnnounce,
	readAloud,
	open,
	onOpenChange,
}: PickersProps) {
	const settings = useStore(store, (state) => state.settings);
	const models = useStore(store, (state) => state.models);
	const lastError = useStore(store, (state) => state.lastError);
	const [pending, setPending] = useState<Change>({});
	const pendingNow = useRef(pending);
	pendingNow.current = pending;
	const errorAtAsk = useRef<number>(-1);
	const rulesActive = useStore(store, selectSessionRulesActive);
	const hintId = useId();
	const panelId = useId();
	const panel = useRef<HTMLFieldSetElement>(null);
	const button = useRef<HTMLButtonElement>(null);

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

	// A press outside closes the panel, unless it closes a picker's open menu first.
	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (panel.current?.contains(target) || button.current?.contains(target)) return;
			if (document.querySelector('[role="menu"].pk-picker-menu')) return;
			onOpenChange(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, onOpenChange]);

	function ask(change: Change) {
		errorAtAsk.current = lastError?.seq ?? -1;
		if (onSet(change)) setPending((waiting) => ({ ...waiting, ...change }));
	}

	const shown = settings ? { ...settings, ...pending } : null;
	const bypass = shown?.mode === "bypassPermissions";
	const startMode = shown ? chatStartMode(models, shown.model) : "default";
	const current = shown ? resolveModel(models, shown.model) : null;
	const versions = current ? versionChoices(models, current.family) : [];
	// The host's own mode, not one still waiting, decides whether Ask is the whole story.
	const askWithRules = settings?.mode === "default" && rulesActive;

	return (
		<>
			<button
				type="button"
				ref={button}
				className={`pk-composer-options${bypass ? " is-warning" : ""}`}
				aria-expanded={open}
				aria-controls={panelId}
				data-testid="composer-options"
				onClick={() => onOpenChange(!open)}
			>
				<Icon name={bypass ? "alert" : "agent"} size="sm" />
				<span className="sr-only">Chat options: </span>
				<span className="pk-composer-options-summary">
					{shown ? summaryOf(shown, models) : <Skeleton width="6rem" />}
				</span>
				<Icon name={open ? "chevron-up" : "chevron-down"} size="sm" />
			</button>
			<fieldset
				ref={panel}
				id={panelId}
				className="pk-composer-picks"
				data-testid="composer-picks"
				hidden={!open}
				onKeyDown={(event) => {
					// A picker's menu portals out of the panel; its Escape is its own.
					if (event.key !== "Escape" || event.defaultPrevented) return;
					if (!(event.target instanceof Node) || !panel.current?.contains(event.target))
						return;
					event.preventDefault();
					onOpenChange(false);
					button.current?.focus();
				}}
			>
				<legend className="pk-composer-picks-title">Chat options</legend>
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
						{/* Stacked as one cell, so Version sits under Model at any panel width. */}
						<div className="pk-picker-pair">
							<Pick
								label="Model"
								testId="composer-model"
								value={current?.family ?? shown.model}
								choices={familyChoices(models, shown.model)}
								onChoose={(model) => ask({ model })}
							/>
							{versions.length > 0 ? (
								<Pick
									label="Version"
									testId="composer-version"
									value={current?.pinned ?? current?.family ?? shown.model}
									choices={versions}
									onChoose={(model) => ask({ model })}
								/>
							) : null}
						</div>
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
							start={startMode}
							changed={shown.mode !== startMode}
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
				{isSpeechSupported() ? <ReadAloudSwitch readAloud={readAloud} /> : null}
			</fieldset>
			{/* Outside the panel, so Ask never reads as the whole story while it is closed. */}
			{askWithRules ? (
				<p id={hintId} className="pk-picker-hint" data-testid="composer-ask-hint">
					{ASK_RULES_HINT}
				</p>
			) : null}
			<ContextMeter store={store} onAnnounce={onAnnounce} />
		</>
	);
}
