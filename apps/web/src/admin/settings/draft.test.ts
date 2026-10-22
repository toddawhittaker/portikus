import { describe, expect, test } from "vitest";
import { changedKeys } from "./draft.js";
import { numberBody, withUnit } from "./numberSettings.js";
import { footerState } from "./SaveFooter.js";
import { toolsBody } from "./ToolsSection.js";
import { leaveText } from "./unsaved.js";

describe("changedKeys", () => {
	const saved = { grace: "10", idle: "60", voice: true };

	test("an edit back to the saved value, or with outer spaces, is not a change", () => {
		expect(changedKeys(saved, {})).toEqual([]);
		expect(changedKeys(saved, { grace: "10", idle: " 60 ", voice: true })).toEqual([]);
	});

	test("names each changed field in the saved values' order", () => {
		expect(changedKeys(saved, { voice: false, grace: "15" })).toEqual([
			"grace",
			"voice",
		]);
	});
});

describe("numberBody", () => {
	test("sends each changed field as the number the API stores", () => {
		const text = { shutdownGraceSeconds: "1.5", idleStopMinutes: "0" };
		expect(
			numberBody(
				["shutdownGraceSeconds", "idleStopMinutes"],
				(key) => text[key as keyof typeof text],
			),
		).toEqual({ body: { shutdownGraceSeconds: 90, idleStopMinutes: 0 } });
	});

	test("names what to enter for each bad field, and sends nothing", () => {
		const text = { idleStopMinutes: "9", cpuThrottleHoldHours: "ten" };
		expect(
			numberBody(
				["idleStopMinutes", "cpuThrottleHoldHours"],
				(key) => text[key as keyof typeof text],
			),
		).toEqual({
			errors: {
				idleStopMinutes:
					"Enter 0 to turn idle stop off, or a whole number from 10 to 1,440.",
				cpuThrottleHoldHours: "Enter a whole number from 1 to 168.",
			},
		});
	});
});

test("a value reads with its unit, singular for one", () => {
	expect(withUnit("80", "%")).toBe("80%");
	expect(withUnit("60", "minutes")).toBe("60 minutes");
	expect(withUnit("1", "hours")).toBe("1 hour");
	expect(withUnit("1", "slowdowns")).toBe("1 slowdown");
});

describe("toolsBody", () => {
	const ticks = { python: false, typescript: true, voiceInputEnabled: true };
	const value = (key: keyof typeof ticks) => ticks[key];

	test("a language change sends the whole set, in the contract's order", () => {
		expect(toolsBody(["python"], value)).toEqual({ codeHelpLanguages: ["typescript"] });
	});

	test("a voice change alone leaves the languages out", () => {
		expect(toolsBody(["voiceInputEnabled"], value)).toEqual({
			voiceInputEnabled: true,
		});
	});
});

describe("footerState", () => {
	const base = { count: 0, firstError: null, failure: null, justSaved: false };

	test("says what is unsaved, what to fix, and when it saved", () => {
		expect(footerState(base).text).toBe("No unsaved changes.");
		expect(footerState({ ...base, justSaved: true }).text).toBe("Saved.");
		expect(footerState({ ...base, count: 3 })).toEqual({
			text: "3 unsaved changes",
			strong: true,
		});
		expect(
			footerState({ ...base, count: 1, failure: "The server is busy." }).text,
		).toBe("Not saved. The server is busy.");
		expect(footerState({ ...base, count: 2, firstError: "Idle stop" }).text).toBe(
			"Not saved. 2 unsaved changes; fix Idle stop and save again.",
		);
	});
});

test("the leave text names each section and count", () => {
	expect(leaveText(new Map([["When workspaces stop", 1]]))).toBe(
		"When workspaces stop has 1 unsaved change. It is lost if you leave.",
	);
	expect(
		leaveText(
			new Map([
				["Resource guard", 2],
				["Email and alerts", 1],
			]),
		),
	).toBe(
		"Resource guard has 2 unsaved changes. Email and alerts has 1 unsaved change. They are lost if you leave.",
	);
});
