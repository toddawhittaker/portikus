/**
 * The Model, Version, Effort and Permissions pickers' choices, worked out
 * from the lists the agent gave the host (SPEC.md §10.8). For Claude Code a
 * short name such as `opus` means the newest version of that family; a full
 * ID such as `claude-opus-4-8` pins one, and a family's pinned versions are
 * the rows named `claude-<short>-…`. A list with no pinned versions, such as
 * Codex's, names each model by its display name and has no Version picker.
 * Each model lists its own efforts, and the host lists its permission modes.
 */
import {
	CHAT_START_SETTINGS,
	type ChatEffort,
	type ChatModeInfo,
	type ChatModelInfo,
	type ChatPermissionMode,
	type CodingAgent,
	chatStartMode,
} from "@portikus/contracts";

export interface ModelChoice {
	value: string;
	label: string;
	description: string;
}

/** The picker's value for the default model, which the list always opens with. */
const DEFAULT_MODEL = "default";

const FULL_ID = "claude-";

function isShortName(value: string): boolean {
	return !value.startsWith(FULL_ID);
}

/** The list pins versions of its families, so it has a Version picker and names families by their short name. */
function hasPinnedVersions(models: readonly ChatModelInfo[]): boolean {
	return models.some((row) => !isShortName(row.value));
}

/** A suffix such as `[1m]` names a window, not a version. */
function withoutSuffix(model: string): string {
	return model.replace(/\[[^\]]*\]$/, "");
}

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "4.8" from "Opus 4.8"; the whole name when it holds no number. */
function versionName(displayName: string): string {
	return /(\d+(?:\.\d+)*)\s*$/.exec(displayName)?.[1] ?? displayName;
}

/** The family and version a model value stands for; `pinned` is null for the newest. */
export function resolveModel(
	models: readonly ChatModelInfo[],
	model: string,
): { family: string; pinned: string | null } {
	const base = withoutSuffix(model);
	const shorts = models.filter(
		(row) => isShortName(row.value) && row.value !== DEFAULT_MODEL,
	);
	if (isShortName(base)) return { family: base, pinned: null };
	const row = models.find((one) => one.value === base);
	// The newest version of a family has no row of its own, but its short name resolves to it.
	const resolved = row?.resolvedModel ?? base;
	const latest = shorts.find((one) => one.resolvedModel === resolved);
	if (latest) return { family: latest.value, pinned: null };
	const family = shorts.find((one) => base.startsWith(`${FULL_ID}${one.value}-`));
	// A family the list does not know shows as it is.
	return family
		? { family: family.value, pinned: base }
		: { family: base, pinned: null };
}

/** A family's name in the Model picker: "Opus" in a list with versions, else the display name. */
function familyLabel(models: readonly ChatModelInfo[], row: ChatModelInfo): string {
	if (row.value === DEFAULT_MODEL) return "Default";
	return hasPinnedVersions(models) ? titleCase(row.value) : row.displayName;
}

/**
 * The Model picker's rows: Claude Code's default first, then each family.
 * Only Claude Code has a default row; another agent's list stands as given.
 */
export function familyChoices(
	models: readonly ChatModelInfo[],
	current: string,
	agent: CodingAgent = "claude",
): ModelChoice[] {
	const rows: ModelChoice[] = models
		.filter((row) => isShortName(row.value))
		.map((row) => ({
			value: row.value,
			label: familyLabel(models, row),
			description: row.description,
		}));
	if (agent === "claude" && !rows.some((row) => row.value === DEFAULT_MODEL)) {
		rows.unshift({
			value: DEFAULT_MODEL,
			label: "Default",
			description: "The model Claude Code picks for your account.",
		});
	}
	// Until the list arrives, or when it leaves the current model out, the picker still shows it.
	const { family } = resolveModel(models, current);
	if (!rows.some((row) => row.value === family)) {
		const label = agent === "claude" ? titleCase(family) : family;
		rows.push({ value: family, label, description: "" });
	}
	return rows;
}

/** The Version picker's rows for a family: Latest first, then the pinned versions, newest first. */
export function versionChoices(
	models: readonly ChatModelInfo[],
	family: string,
): ModelChoice[] {
	const latest = models.find((row) => row.value === family);
	if (!latest || family === DEFAULT_MODEL || !hasPinnedVersions(models)) return [];
	const pinned = models
		.filter(
			(row) =>
				row.value.startsWith(`${FULL_ID}${family}-`) &&
				row.resolvedModel !== latest.resolvedModel,
		)
		.map((row) => ({
			value: row.value,
			label: versionName(row.displayName),
			description: row.description,
		}))
		.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
	return [
		{
			value: latest.value,
			label: `Latest (${versionName(latest.displayName)})`,
			description: "Follows new releases of this model.",
		},
		...pinned,
	];
}

/**
 * "Opus", or "Opus 4.8" when a version is pinned, for the options summary;
 * "GPT-5.5" from a list with no versions; the agent's name for the default.
 */
export function modelSummary(
	models: readonly ChatModelInfo[],
	model: string,
	agentName = "Claude",
): string {
	const { family, pinned } = resolveModel(models, model);
	if (family === DEFAULT_MODEL) return agentName;
	if (!hasPinnedVersions(models)) {
		return models.find((row) => row.value === family)?.displayName ?? family;
	}
	if (!pinned) return titleCase(family);
	const row = models.find((one) => one.value === pinned);
	// With no row to name it, the ID's own digits: "claude-sonnet-4-5" is "4.5".
	const digits = pinned.slice(`${FULL_ID}${family}-`.length).replace(/-/g, ".");
	return `${titleCase(family)} ${row ? versionName(row.displayName) : digits}`;
}

/**
 * A saved model the list still offers, else its family's short name, else
 * the default, else `fallback` for a list with no default row (SPEC.md
 * §10.8). With no list to check against, the model stands.
 */
export function offeredModel(
	models: readonly ChatModelInfo[],
	model: string,
	fallback = DEFAULT_MODEL,
): string {
	if (models.length === 0 || models.some((row) => row.value === model)) return model;
	const { family } = resolveModel(models, model);
	if (models.some((row) => row.value === family)) return family;
	return models.some((row) => row.value === DEFAULT_MODEL) ? DEFAULT_MODEL : fallback;
}

/** Whether two model values mean the same choice, such as `opus` and the full ID it resolves to. */
export function sameModel(
	models: readonly ChatModelInfo[],
	a: string,
	b: string,
): boolean {
	const left = resolveModel(models, a);
	const right = resolveModel(models, b);
	return left.family === right.family && left.pinned === right.pinned;
}

/** The list's row for a model value, its window suffix ignored. */
function rowOf(
	models: readonly ChatModelInfo[],
	model: string,
): ChatModelInfo | undefined {
	return (
		models.find((row) => row.value === model) ??
		models.find((row) => row.value === withoutSuffix(model))
	);
}

/** Portikus's words for the efforts it knows; any other shows as the host wrote it. */
const EFFORT_WORDS: Record<string, { label: string; description: string }> = {
	low: { label: "Low", description: "Answers quickly with little thinking." },
	medium: { label: "Medium", description: "Thinks a little before acting." },
	high: { label: "High", description: "Thinks it through. Slower, uses more." },
	xhigh: { label: "Extra high", description: "Thinks at length. For tricky problems." },
	max: { label: "Max", description: "Thinks the longest. Slowest, uses the most." },
};

/** The efforts offered when the host lists none for a model, as before efforts were listed. */
const FALLBACK_EFFORTS: readonly ChatEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function effortLabel(effort: ChatEffort): string {
	return EFFORT_WORDS[effort]?.label ?? effort;
}

/** The Effort picker's rows: the model's own efforts, lowest first. */
export function effortChoices(
	models: readonly ChatModelInfo[],
	model: string,
): ModelChoice[] {
	const efforts = rowOf(models, model)?.efforts ?? FALLBACK_EFFORTS;
	return efforts.map((value) => ({
		value,
		label: effortLabel(value),
		description: EFFORT_WORDS[value]?.description ?? "",
	}));
}

/** The effort a chat on this model starts at: the model's own default, else Portikus's. */
export function startEffort(
	models: readonly ChatModelInfo[],
	model: string,
): ChatEffort {
	return rowOf(models, model)?.defaultEffort ?? CHAT_START_SETTINGS.effort;
}

/** Whether the model accepts the effort; true when the host lists no efforts for it. */
export function offersEffort(
	models: readonly ChatModelInfo[],
	model: string,
	effort: ChatEffort,
): boolean {
	const efforts = rowOf(models, model)?.efforts;
	return efforts === undefined || efforts.includes(effort);
}

/**
 * Claude Code's modes, for a host that sends no list of its own. A host that
 * does send one is drawn from it, with its own words.
 */
const FALLBACK_MODES: readonly ChatModeInfo[] = [
	{
		id: "default",
		label: "Ask",
		description: "Asks before it edits files or runs commands.",
		warning: false,
		plan: false,
	},
	{
		id: "acceptEdits",
		label: "Accept edits",
		description: "Edits files on its own. Asks before commands.",
		warning: false,
		plan: false,
	},
	{
		id: "plan",
		label: "Plan",
		description: "Reads and plans. Changes nothing.",
		warning: false,
		plan: true,
	},
	{
		id: "auto",
		label: "Auto",
		description: "Runs what it judges safe. Asks about the rest.",
		warning: false,
		plan: false,
	},
	{
		id: "bypassPermissions",
		label: "Bypass permissions",
		description:
			"Bypass permissions lets Claude run every tool without asking you first.",
		warning: true,
		plan: false,
	},
];

/** The Permissions picker's modes: the host's list, or Claude Code's when it sent none. */
export function modeChoices(modes: readonly ChatModeInfo[]): readonly ChatModeInfo[] {
	return modes.length > 0 ? modes : FALLBACK_MODES;
}

/** The mode with this id, from the host's list or the fallback. */
export function modeOf(
	modes: readonly ChatModeInfo[],
	id: ChatPermissionMode,
): ChatModeInfo | undefined {
	return modeChoices(modes).find((mode) => mode.id === id);
}

/** Codex's own default mode, Auto: `on-request` in the workspace sandbox. */
const CODEX_START_MODE = "onRequest";

/** The mode a new chat of this agent starts in, marked Default in the menu. */
export function startMode(
	agent: CodingAgent,
	models: readonly ChatModelInfo[],
	model: string,
): ChatPermissionMode {
	return agent === "codex" ? CODEX_START_MODE : chatStartMode(models, model);
}
