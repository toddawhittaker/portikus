/**
 * The agent, model, effort and permission pickers along the composer's
 * bottom edge (SPEC.md §10.8). They show what the host last reported in a
 * `settings` event and change it by asking, never by assuming.
 */
import { ChatEffort, ChatPermissionMode } from "@portikus/contracts";
import type { ReactNode } from "react";
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

export const BYPASS_WARNING =
	"Bypass permissions lets Claude run every tool without asking you first.";

/** The picker entry for the model id the host reports, which may be a full name. */
function modelChoice(model: string): string {
	const known = MODELS.find((choice) => choice.value === model);
	if (known) return known.value;
	const family = MODELS.find(
		(choice) => choice.value !== "default" && model.includes(choice.value),
	);
	return family?.value ?? "default";
}

interface PickersProps {
	settings: ChatState["settings"];
	warningId: string;
	onSet: (settings: {
		model?: string;
		effort?: ChatEffort;
		mode?: ChatPermissionMode;
	}) => void;
}

interface PickProps {
	label: string;
	testId: string;
	/** Undefined until the host has reported its settings. */
	value: string | undefined;
	onChoose: (value: string) => void;
	describedBy?: string;
	children: ReactNode;
}

function Pick({ label, testId, value, onChoose, describedBy, children }: PickProps) {
	return (
		<select
			className="pk-composer-pick pk-focus-ring"
			aria-label={label}
			aria-describedby={describedBy}
			data-testid={testId}
			value={value ?? ""}
			onChange={(event) => onChoose(event.target.value)}
		>
			{value === undefined ? (
				<option value="" disabled={true} hidden={true}>
					{label}
				</option>
			) : null}
			{children}
		</select>
	);
}

export function ComposerPickers({ settings, warningId, onSet }: PickersProps) {
	const bypass = settings?.mode === "bypassPermissions";
	return (
		<fieldset className="pk-composer-picks">
			<legend className="sr-only">Chat settings</legend>
			<Pick label="Agent" testId="composer-agent" value="claude" onChoose={() => {}}>
				<option value="claude">Claude Code</option>
				<option value="codex" disabled={true}>
					Codex (coming soon)
				</option>
			</Pick>
			<Pick
				label="Model"
				testId="composer-model"
				value={settings ? modelChoice(settings.model) : undefined}
				onChoose={(model) => onSet({ model })}
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
				value={settings?.effort}
				onChoose={(effort) => onSet({ effort: ChatEffort.parse(effort) })}
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
				value={settings?.mode}
				onChoose={(mode) => onSet({ mode: ChatPermissionMode.parse(mode) })}
				describedBy={bypass ? warningId : undefined}
			>
				{MODES.map((choice) => (
					<option key={choice.value} value={choice.value}>
						{choice.label}
					</option>
				))}
			</Pick>
		</fieldset>
	);
}
