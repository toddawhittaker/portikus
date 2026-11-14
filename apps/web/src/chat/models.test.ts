import type { ChatModelInfo } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	effortChoices,
	effortLabel,
	familyChoices,
	modeChoices,
	modelSummary,
	modeOf,
	offeredModel,
	offersEffort,
	resolveModel,
	sameModel,
	startEffort,
	startMode,
	versionChoices,
} from "./models.js";

const row = (
	value: string,
	displayName: string,
	resolvedModel = value,
): ChatModelInfo => ({
	value,
	displayName,
	resolvedModel,
	description: "",
	supportsAutoMode: true,
});

const LIST = [
	row("default", "Default (recommended)", "claude-opus-5-5"),
	row("opus", "Opus 5.5", "claude-opus-5-5"),
	row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
	row("claude-opus-5-5", "Opus 5.5"),
	row("claude-opus-4-8", "Opus 4.8"),
	row("claude-opus-4-7", "Opus 4.7"),
	row("claude-opus-5", "Opus 5"),
	row("claude-sonnet-4-6", "Sonnet 4.6"),
];

test("a model value resolves to its family and, for a full ID, its pinned version", () => {
	expect(resolveModel(LIST, "opus")).toEqual({ family: "opus", pinned: null });
	expect(resolveModel(LIST, "default")).toEqual({ family: "default", pinned: null });
	expect(resolveModel(LIST, "claude-opus-4-8")).toEqual({
		family: "opus",
		pinned: "claude-opus-4-8",
	});
	// The ID a short name resolves to is that family's newest, even when it has a row.
	expect(resolveModel(LIST, "claude-opus-5-5")).toEqual({
		family: "opus",
		pinned: null,
	});
	expect(resolveModel(LIST, "claude-opus-5-5[1m]")).toEqual({
		family: "opus",
		pinned: null,
	});
	// A full ID with no row still belongs to the family its name starts with.
	expect(resolveModel(LIST, "claude-sonnet-4-5")).toEqual({
		family: "sonnet",
		pinned: "claude-sonnet-4-5",
	});
	// With no list, or a family it does not know, the value stands as it is.
	expect(resolveModel([], "fable")).toEqual({ family: "fable", pinned: null });
	expect(resolveModel(LIST, "claude-mystery-1")).toEqual({
		family: "claude-mystery-1",
		pinned: null,
	});
});

test("the Version rows put Latest first, then pinned versions newest first, leaving out the newest's own row", () => {
	const rows = versionChoices(LIST, "opus");
	expect(rows.map((one) => one.value)).toEqual([
		"opus",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
	]);
	expect(rows.map((one) => one.label)).toEqual(["Latest (5.5)", "5", "4.8", "4.7"]);
	expect(versionChoices(LIST, "default")).toEqual([]);
	expect(versionChoices(LIST, "unknown")).toEqual([]);
	expect(versionChoices([], "opus")).toEqual([]);
});

test("the Model rows are Default and the short names, and the current family is kept when the list lacks it", () => {
	expect(familyChoices(LIST, "opus").map((one) => one.label)).toEqual([
		"Default",
		"Opus",
		"Sonnet",
	]);
	expect(familyChoices([], "default").map((one) => one.label)).toEqual(["Default"]);
	expect(familyChoices([], "fable").map((one) => one.label)).toEqual([
		"Default",
		"Fable",
	]);
});

test("the summary names a pinned version, and the default model reads as Claude", () => {
	expect(modelSummary(LIST, "opus")).toBe("Opus");
	expect(modelSummary(LIST, "claude-opus-4-8")).toBe("Opus 4.8");
	expect(modelSummary(LIST, "default")).toBe("Claude");
	expect(modelSummary(LIST, "claude-sonnet-4-5")).toBe("Sonnet 4.5");
});

test("a saved model is kept when offered, else its family's newest, else the default", () => {
	expect(offeredModel(LIST, "claude-opus-4-8")).toBe("claude-opus-4-8");
	expect(offeredModel(LIST, "claude-opus-4-1")).toBe("opus");
	expect(offeredModel(LIST, "fable")).toBe("default");
	expect(offeredModel([], "fable")).toBe("fable");
});

test("two values are the same choice when they mean the same family and version", () => {
	expect(sameModel(LIST, "opus", "claude-opus-5-5[1m]")).toBe(true);
	expect(sameModel(LIST, "opus", "claude-opus-4-8")).toBe(false);
	expect(sameModel(LIST, "opus", "sonnet")).toBe(false);
});

const codexRow = (
	value: string,
	displayName: string,
	efforts?: string[],
	defaultEffort?: string,
): ChatModelInfo => ({
	...row(value, displayName),
	...(efforts ? { efforts } : {}),
	...(defaultEffort ? { defaultEffort } : {}),
});

const CODEX = [
	codexRow("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh", "ultra"], "high"),
	codexRow("gpt-5.4-mini", "GPT-5.4 mini"),
];

test("a list with no pinned versions names models by their display names and has no Version rows", () => {
	expect(familyChoices(CODEX, "gpt-5.5", "codex").map((one) => one.label)).toEqual([
		"GPT-5.5",
		"GPT-5.4 mini",
	]);
	expect(versionChoices(CODEX, "gpt-5.5")).toEqual([]);
	expect(modelSummary(CODEX, "gpt-5.4-mini", "Codex")).toBe("GPT-5.4 mini");
	// A model the list does not know shows as it is, with no Default row added.
	expect(familyChoices(CODEX, "gpt-6", "codex").map((one) => one.label)).toEqual([
		"GPT-5.5",
		"GPT-5.4 mini",
		"gpt-6",
	]);
	expect(modelSummary(CODEX, "gpt-6", "Codex")).toBe("gpt-6");
	expect(modelSummary(LIST, "default", "Codex")).toBe("Codex");
});

test("a saved model a list with no default row lacks falls back to the given model", () => {
	expect(offeredModel(CODEX, "gpt-4", "gpt-5.5")).toBe("gpt-5.5");
	expect(offeredModel(LIST, "fable", "opus")).toBe("default");
});

test("efforts come from the model's own list, worded where known and as written otherwise", () => {
	expect(effortChoices(CODEX, "gpt-5.5").map((one) => one.label)).toEqual([
		"Low",
		"Medium",
		"High",
		"Extra high",
		"ultra",
	]);
	expect(effortChoices(CODEX, "gpt-5.5").at(-1)?.description).toBe("");
	// A model with no list, or none known, keeps Portikus's five.
	expect(effortChoices(CODEX, "gpt-5.4-mini").map((one) => one.value)).toEqual([
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	expect(effortChoices([], "opus")).toHaveLength(5);
	expect(effortLabel("max")).toBe("Max");
	expect(effortLabel("minimal")).toBe("minimal");
	expect(startEffort(CODEX, "gpt-5.5")).toBe("high");
	expect(startEffort(CODEX, "gpt-5.4-mini")).toBe("medium");
	expect(offersEffort(CODEX, "gpt-5.5", "ultra")).toBe(true);
	expect(offersEffort(CODEX, "gpt-5.5", "max")).toBe(false);
	expect(offersEffort(CODEX, "gpt-5.4-mini", "max")).toBe(true);
	// A window suffix still finds the model's row.
	expect(startEffort(CODEX, "gpt-5.5[1m]")).toBe("high");
});

test("modes come from the host's list, or Claude Code's five when it sends none", () => {
	const host = [
		{ id: "untrusted", label: "Ask", description: "", warning: false, plan: false },
	];
	expect(modeChoices(host)).toBe(host);
	expect(modeChoices([]).map((mode) => mode.id)).toEqual([
		"default",
		"acceptEdits",
		"plan",
		"auto",
		"bypassPermissions",
	]);
	expect(modeOf([], "bypassPermissions")?.warning).toBe(true);
	expect(modeOf(host, "bypassPermissions")).toBeUndefined();
	expect(startMode("codex", [], "gpt-5.5")).toBe("onRequest");
	expect(startMode("claude", [], "opus")).toBe("auto");
});
