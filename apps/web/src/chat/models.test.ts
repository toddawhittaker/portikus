import type { ChatModelInfo } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	familyChoices,
	modelSummary,
	offeredModel,
	resolveModel,
	sameModel,
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
