import { AssistantUnavailableReason } from "@portikus/contracts";
import { expect, test } from "vitest";
import { ApiError } from "../api/request.js";
import { isNotEnabled, notEnabledText } from "./useAssistant.js";

test("only the server's AI_NOT_ENABLED code reads as not enabled", () => {
	expect(
		isNotEnabled(
			new ApiError(409, "The built-in AI is switched off.", "AI_NOT_ENABLED"),
		),
	).toBe(true);
	expect(
		isNotEnabled(new ApiError(403, "The assistant is not enabled.", "FORBIDDEN")),
	).toBe(false);
	expect(isNotEnabled(new Error("not enabled"))).toBe(false);
});

test("every reason has its own browser line", () => {
	const lines = AssistantUnavailableReason.options.map((reason) =>
		notEnabledText({ enabled: false, reason }),
	);
	expect(new Set(lines).size).toBe(lines.length);
	for (const line of lines) expect(line).toMatch(/assistant/i);
});
