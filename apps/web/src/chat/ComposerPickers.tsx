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

import {
	ChatEffort,
	type ChatModeInfo,
	type ChatModelInfo,
	ChatPermissionMode,
	CODING_AGENT_LABEL,
	type CodingAgent,
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
import { CODING_AGENT_NAME } from "../agents/codingAgentName.js";
import { isSpeechSupported } from "../voice/speak.js";
import { ContextMeter } from "./ContextMeter.js";
import {
	type ChatSettings,
	type ChatStore,
	isEmptyChat,
	selectSessionRulesActive,
} from "./chatStore.js";
import { McpServers } from "./McpServers.js";
import {
	effortChoices,
	effortLabel,
	familyChoices,
	modeChoices,
	modelSummary,
	modeOf,
	resolveModel,
	startEffort,
	startMode,
	versionChoices,
} from "./models.js";
import type { ReadAloud } from "./readAloud.js";
import "./pickers.css";

/** Ask with session rules lets some tools run without a card, so the picker says so (SPEC.md §10.8). */
export const ASK_RULES_HINT =
	"Some actions are allowed without asking in this session. See \u201cAllowed without asking in this session\u201d above.";

interface Choice {
	value: string;
	label: string;
	description: ReactNode;
	/** Shown but cannot be chosen yet. */
	unavailable?: boolean;
}

const AGENTS: readonly CodingAgent[] = ["claude", "codex"];

const AGENT_DESCRIPTION: Record<CodingAgent, string> = {
	claude: "Anthropic's coding agent.",
	codex: "OpenAI's coding agent.",
};

/** What swapping agents in a chat with history costs, said before it is chosen (SPEC.md §10.8). */
function swapWarning(agent: CodingAgent): string {
	const name = CODING_AGENT_NAME[agent];
	return `${name} starts fresh with this conversation as context; the cache is lost. If the conversation is too long for ${name}, its oldest turns are left out.`;
}

/**
 * How long a swap waits for the new host's settings before the pickers come
 * back, so a host that never reports them cannot hide them for good.
 */
export const AGENT_START_TIMEOUT_MS = 30_000;

/**
 * What `onSwitchAgent` rejects with when the student has already been told
 * why the swap failed, as a toast is, so the composer does not say it twice.
 */
export class AgentSwitchReported extends Error {
	constructor() {
		super("The agent switch failed and was already reported.");
		this.name = "AgentSwitchReported";
	}
}

/**
 * The agent picker's rows. In an empty chat the other agent takes this
 * chat's place at once. In a chat with history it swaps in after a warning,
 * in the warning colour and icon as Bypass has, and is handed the
 * conversation. While a swap is pending the agent being left is not
 * unavailable, only busy. Where the chat cannot swap, the other agent is
 * shown but cannot be chosen, and says how to start it.
 */
function agentChoices(
	current: CodingAgent,
	canSwitch: boolean,
	switching: boolean,
	empty: boolean,
): Choice[] {
	return AGENTS.map((agent) => {
		if (agent === current) {
			return {
				value: agent,
				label: CODING_AGENT_NAME[agent],
				description: AGENT_DESCRIPTION[agent],
			};
		}
		if (switching) {
			return {
				value: agent,
				label: CODING_AGENT_NAME[agent],
				description: "Switching\u2026",
				unavailable: true,
			};
		}
		if (!canSwitch) {
			return {
				value: agent,
				label: CODING_AGENT_NAME[agent],
				description: `To use ${CODING_AGENT_NAME[agent]} now, start a new chat from the New tab menu.`,
				unavailable: true,
			};
		}
		return {
			value: agent,
			label: CODING_AGENT_NAME[agent],
			description: empty ? (
				AGENT_DESCRIPTION[agent]
			) : (
				<span className="pk-picker-warning">
					<Icon name="alert" size="sm" />
					<span>{swapWarning(agent)}</span>
				</span>
			),
		};
	});
}

/** A mode that warns carries its words in the warning colour and icon, before it is chosen. */
function modeChoice(mode: ChatModeInfo): Choice {
	return {
		value: mode.id,
		label: mode.label,
		description: mode.warning ? (
			<span className="pk-picker-warning">
				<Icon name="alert" size="sm" />
				<span>{mode.description}</span>
			</span>
		) : (
			mode.description
		),
	};
}

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
	/** The choice is being carried out; the picker says so until it is done. */
	busy?: boolean;
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
	busy = false,
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
					aria-busy={busy ? true : undefined}
					data-testid={testId}
				>
					{/* The space keeps the name "Model Opus", not "ModelOpus". */}
					<span className="pk-picker-label">{label}</span>{" "}
					<span className="pk-picker-current">
						{warning ? <Icon name="alert" size="sm" /> : null}
						<span className="pk-picker-value">{shown}</span>
						<Icon name="chevron-down" size="sm" />
					</span>
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

/** The "Read replies aloud" switch (ADR 0071), in the options panel's heading row. */
function ReadAloudSwitch({ readAloud }: { readAloud: ReadAloud }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={readAloud.on}
			className="pk-picks-aloud"
			data-testid="composer-read-aloud"
			onClick={() => readAloud.set(!readAloud.on)}
		>
			<span>Read replies aloud</span>
			{/* The state is the switch's own; the track and the word are for the eye. */}
			<span className="pk-picks-aloud-track" aria-hidden={true} />
			<span className="pk-picks-aloud-state" aria-hidden={true}>
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
	/** Whether the MCP server list is showing; the composer opens it for `/mcp`. */
	mcpOpen: boolean;
	onMcpOpenChange: (open: boolean) => void;
	/**
	 * Put the other agent in this chat's place; absent where the chat has no
	 * work area to swap it in. It settles when the swap is asked for, and a
	 * refusal rejects with what to tell the student.
	 */
	onSwitchAgent?: (agent: CodingAgent) => Promise<void>;
}

/** The short summary on the Options button: agent or model, effort, permissions. */
function summaryOf(
	shown: ChatSettings,
	models: readonly ChatModelInfo[],
	modes: readonly ChatModeInfo[],
): string {
	const first = modelSummary(models, shown.model, CODING_AGENT_LABEL[shown.agent]);
	const mode = modeOf(modes, shown.mode)?.label ?? shown.mode;
	return [first, effortLabel(shown.effort), mode].join(" \u00b7 ");
}

export function ComposerPickers({
	store,
	warningId,
	onSet,
	onAnnounce,
	readAloud,
	open,
	onOpenChange,
	mcpOpen,
	onMcpOpenChange,
	onSwitchAgent,
}: PickersProps) {
	const settings = useStore(store, (state) => state.settings);
	const models = useStore(store, (state) => state.models);
	const modes = useStore(store, (state) => state.modes);
	const mcp = useStore(store, (state) => state.mcp);
	const empty = useStore(store, isEmptyChat);
	const lastError = useStore(store, (state) => state.lastError);
	const [pending, setPending] = useState<Change>({});
	const pendingNow = useRef(pending);
	pendingNow.current = pending;
	const errorAtAsk = useRef<number>(-1);
	const rulesActive = useStore(store, selectSessionRulesActive);
	/** The agent asked for, shown until the host reports it runs. */
	const [agentAsked, setAgentAsked] = useState<CodingAgent | null>(null);
	const agentAskedNow = useRef(agentAsked);
	agentAskedNow.current = agentAsked;
	const hintId = useId();
	const panelId = useId();
	const panel = useRef<HTMLFieldSetElement>(null);
	const button = useRef<HTMLButtonElement>(null);

	// The host's report is the truth; it ends any wait.
	useEffect(() => {
		if (settings) setPending({});
		if (settings && agentAsked !== null && settings.agent === agentAsked) {
			setAgentAsked(null);
			onAnnounce(`Now chatting with ${CODING_AGENT_NAME[agentAsked]}`);
		}
	}, [settings, agentAsked, onAnnounce]);

	// A host that never reports its settings must not hide the pickers for good.
	useEffect(() => {
		if (agentAsked === null) return;
		const timer = setTimeout(() => {
			setAgentAsked(null);
			onAnnounce(
				`${CODING_AGENT_NAME[agentAsked]} has not reported its settings, so the options shown are for the previous agent. Reload the page if the chat does not respond.`,
			);
		}, AGENT_START_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [agentAsked, onAnnounce]);

	// An error while a change waits means the host refused it.
	useEffect(() => {
		if (!lastError || lastError.seq <= errorAtAsk.current) return;
		const swapping = agentAskedNow.current;
		if (swapping !== null) {
			setAgentAsked(null);
			onAnnounce(`${CODING_AGENT_NAME[swapping]} did not start. ${lastError.message}`);
			return;
		}
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

	function chooseAgent(next: CodingAgent) {
		if (!onSwitchAgent) return;
		setAgentAsked(next);
		errorAtAsk.current = lastError?.seq ?? -1;
		// A chat with history keeps its tab; an empty one is replaced by a new chat.
		onAnnounce(
			empty
				? `Starting a ${CODING_AGENT_NAME[next]} chat\u2026`
				: `Switching to ${CODING_AGENT_NAME[next]}\u2026`,
		);
		onSwitchAgent(next).catch((error: unknown) => {
			setAgentAsked(null);
			if (error instanceof AgentSwitchReported) {
				// Told elsewhere; only the status line's "starting" is taken back.
				onAnnounce("");
				return;
			}
			const reason = error instanceof Error ? ` ${error.message}` : "";
			onAnnounce(`The agent did not change.${reason}`);
		});
	}

	function ask(change: Change) {
		errorAtAsk.current = lastError?.seq ?? -1;
		if (onSet(change)) setPending((waiting) => ({ ...waiting, ...change }));
	}

	// While another agent starts, the old agent's pickers mean nothing.
	const shown = settings && agentAsked === null ? { ...settings, ...pending } : null;
	const agent = agentAsked ?? settings?.agent ?? "claude";
	const warning = shown ? modeOf(modes, shown.mode)?.warning === true : false;
	const firstMode = shown ? startMode(agent, models, shown.model) : null;
	const firstEffort = shown ? startEffort(models, shown.model) : null;
	const current = shown ? resolveModel(models, shown.model) : null;
	const versions = current ? versionChoices(models, current.family) : [];
	// The host's own mode, not one still waiting, decides whether Ask is the whole story.
	const askWithRules = settings?.mode === "default" && rulesActive;

	return (
		<>
			<button
				type="button"
				ref={button}
				className={`pk-composer-options${warning ? " is-warning" : ""}`}
				aria-expanded={open}
				aria-controls={panelId}
				data-testid="composer-options"
				onClick={() => onOpenChange(!open)}
			>
				<Icon name={warning ? "alert" : "agent"} size="sm" />
				<span className="sr-only">Chat options: </span>
				<span className="pk-composer-options-summary">
					{shown ? summaryOf(shown, models, modes) : <Skeleton width="6rem" />}
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
				{isSpeechSupported() ? <ReadAloudSwitch readAloud={readAloud} /> : null}
				<div className="pk-composer-picks-fields">
					<Pick
						label="Agent"
						testId="composer-agent"
						value={agent}
						busy={agentAsked !== null}
						choices={agentChoices(
							agent,
							onSwitchAgent !== undefined,
							agentAsked !== null,
							empty,
						)}
						onChoose={(next) => chooseAgent(next === "codex" ? "codex" : "claude")}
					/>
					{shown ? (
						<>
							{/* One unit, so Version never wraps away from Model. */}
							<div className="pk-picker-pair">
								<Pick
									label="Model"
									testId="composer-model"
									value={current?.family ?? shown.model}
									choices={familyChoices(models, shown.model, agent)}
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
								choices={effortChoices(models, shown.model)}
								start={firstEffort ?? undefined}
								changed={shown.effort !== firstEffort}
								onChoose={(effort) => ask({ effort: ChatEffort.parse(effort) })}
							/>
							<Pick
								label="Permissions"
								testId="composer-mode"
								value={shown.mode}
								choices={modeChoices(modes).map(modeChoice)}
								start={firstMode ?? undefined}
								changed={shown.mode !== firstMode}
								warning={warning}
								describedBy={warning ? warningId : askWithRules ? hintId : undefined}
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
					<McpServers
						servers={mcp}
						agent={agent}
						expanded={mcpOpen}
						onExpandedChange={onMcpOpenChange}
					/>
				</div>
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
