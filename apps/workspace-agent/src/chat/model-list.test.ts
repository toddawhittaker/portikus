import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { expect, test, vi } from "vitest";
import { chatModels, ModelList } from "./model-list.js";

const row = (value: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
	value,
	displayName: value,
	description: "",
	...extra,
});

test("rows the contract would refuse are left out and the rest are trimmed", () => {
	const models = chatModels([
		row("opus", { resolvedModel: "claude-opus-5-5", supportsAutoMode: true }),
		row("Bad Value"),
		row("claude-haiku-4-5", { resolvedModel: "x".repeat(101) }),
	]);
	expect(models.map((m) => m.value)).toEqual(["opus", "claude-haiku-4-5"]);
	expect(models[0]).toMatchObject({
		resolvedModel: "claude-opus-5-5",
		supportsAutoMode: true,
	});
	expect(models[1]).not.toHaveProperty("resolvedModel");
	expect(models[1]?.supportsAutoMode).toBe(false);
});

test("a model lists the efforts the SDK reports, with the start effort as its default", () => {
	const [model] = chatModels([
		row("opus", { supportedEffortLevels: ["low", "medium", "high"] }),
	]);
	expect(model?.efforts).toEqual(["low", "medium", "high"]);
	expect(model?.defaultEffort).toBe("medium");
});

test("a model whose row names no efforts gets the five Claude supports today", () => {
	const [plain, empty] = chatModels([
		row("opus"),
		row("sonnet", { supportedEffortLevels: [] }),
	]);
	for (const model of [plain, empty]) {
		expect(model?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(model?.defaultEffort).toBe("medium");
	}
});

test("no default is claimed when the model does not offer the start effort", () => {
	const [model] = chatModels([row("opus", { supportedEffortLevels: ["high", "max"] })]);
	expect(model?.efforts).toEqual(["high", "max"]);
	expect(model).not.toHaveProperty("defaultEffort");
});

test("a list is told once, and a failed read keeps the last list", async () => {
	const told = vi.fn();
	const list = new ModelList(told);
	expect(
		await list.refresh(
			async () => [row("opus")],
			() => true,
		),
	).toHaveLength(1);
	await list.refresh(
		async () => [row("opus")],
		() => true,
	);
	expect(told).toHaveBeenCalledTimes(1);
	const failed = await list.refresh(
		async () => {
			throw new Error("no");
		},
		() => true,
	);
	expect(failed).toBeNull();
	expect(list.current).toHaveLength(1);
	await list.refresh(
		async () => [row("opus"), row("sonnet")],
		() => true,
	);
	expect(told).toHaveBeenCalledTimes(2);
});

test("a read that finishes after its session ended is dropped", async () => {
	const list = new ModelList(vi.fn());
	expect(
		await list.refresh(
			async () => [row("opus")],
			() => false,
		),
	).toBeNull();
	expect(list.current).toBeNull();
});
