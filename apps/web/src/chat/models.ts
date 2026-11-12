/**
 * The model and Version pickers' choices, worked out from the list Claude
 * Code gave the host (SPEC.md §10.8). A short name such as `opus` means the
 * newest version of that family; a full ID such as `claude-opus-4-8` pins
 * one, and a family's pinned versions are the rows named `claude-<short>-…`.
 */
import type { ChatModelInfo } from "@portikus/contracts";

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

/** The Model picker's rows: the default first, then each family. */
export function familyChoices(
	models: readonly ChatModelInfo[],
	current: string,
): ModelChoice[] {
	const rows: ModelChoice[] = models
		.filter((row) => isShortName(row.value))
		.map((row) => ({
			value: row.value,
			label: row.value === DEFAULT_MODEL ? "Default" : titleCase(row.value),
			description: row.description,
		}));
	if (!rows.some((row) => row.value === DEFAULT_MODEL)) {
		rows.unshift({
			value: DEFAULT_MODEL,
			label: "Default",
			description: "The model Claude Code picks for your account.",
		});
	}
	// Until the list arrives, or when it leaves the current model out, the picker still shows it.
	const { family } = resolveModel(models, current);
	if (!rows.some((row) => row.value === family)) {
		rows.push({ value: family, label: titleCase(family), description: "" });
	}
	return rows;
}

/** The Version picker's rows for a family: Latest first, then the pinned versions, newest first. */
export function versionChoices(
	models: readonly ChatModelInfo[],
	family: string,
): ModelChoice[] {
	const latest = models.find((row) => row.value === family);
	if (!latest || family === DEFAULT_MODEL) return [];
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

/** "Opus", or "Opus 4.8" when a version is pinned, for the options summary. */
export function modelSummary(models: readonly ChatModelInfo[], model: string): string {
	const { family, pinned } = resolveModel(models, model);
	if (family === DEFAULT_MODEL) return "Claude";
	if (!pinned) return titleCase(family);
	const row = models.find((one) => one.value === pinned);
	// With no row to name it, the ID's own digits: "claude-sonnet-4-5" is "4.5".
	const digits = pinned.slice(`${FULL_ID}${family}-`.length).replace(/-/g, ".");
	return `${titleCase(family)} ${row ? versionName(row.displayName) : digits}`;
}

/**
 * A saved model the list still offers, else its family's short name, else
 * the default (SPEC.md §10.8). With no list to check against, the model stands.
 */
export function offeredModel(models: readonly ChatModelInfo[], model: string): string {
	if (models.length === 0 || models.some((row) => row.value === model)) return model;
	const { family } = resolveModel(models, model);
	return models.some((row) => row.value === family) ? family : DEFAULT_MODEL;
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
