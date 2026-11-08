import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import {
	alwaysAllowLabel,
	describeRule,
	ruleText,
	splitSuggestions,
} from "./permission-rules.js";

describe("describing rules", () => {
	test("a Bash prefix rule names the command, an exact one quotes it", () => {
		expect(describeRule({ toolName: "Bash", ruleContent: "sed:*" })).toBe(
			'"sed" commands',
		);
		expect(describeRule({ toolName: "Bash", ruleContent: "npm test" })).toBe(
			'the command "npm test"',
		);
		expect(describeRule({ toolName: "Bash" })).toBe("every Bash call");
		expect(describeRule({ toolName: "Read", ruleContent: "//tmp/**" })).toBe(
			'Read on "//tmp/**"',
		);
	});

	test("a long command is cut short in the label", () => {
		const text = describeRule({ toolName: "Bash", ruleContent: "x".repeat(200) });
		expect(text.length).toBeLessThan(100);
		expect(text).toContain("…");
	});

	test("the rule text is Claude Code's own syntax", () => {
		expect(ruleText({ toolName: "Bash", ruleContent: "sed:*" })).toBe("Bash(sed:*)");
		expect(ruleText({ toolName: "WebSearch" })).toBe("WebSearch");
	});

	test("the label names each grant and how long it lasts", () => {
		expect(
			alwaysAllowLabel([
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "sed:*" }],
					behavior: "allow",
					destination: "session",
				},
			]),
		).toBe('Always allow "sed" commands in this session');
		expect(
			alwaysAllowLabel([
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "git status:*" }],
					behavior: "allow",
					destination: "userSettings",
				},
				{ type: "addDirectories", directories: ["/home/s/p"], destination: "session" },
			]),
		).toBe(
			'Always allow "git status" commands in all your projects, saved to your user settings; access to "/home/s/p" in this session',
		);
	});
});

describe("splitting suggestions", () => {
	test("session allow rules go to the host; file rules, modes and denials go to the SDK", () => {
		const fileRule: PermissionUpdate = {
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "ls" }],
			behavior: "allow",
			destination: "projectSettings",
		};
		const denial: PermissionUpdate = {
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
			behavior: "deny",
			destination: "session",
		};
		const mode: PermissionUpdate = {
			type: "setMode",
			mode: "acceptEdits",
			destination: "session",
		};
		const { sessionRules, forSdk } = splitSuggestions([
			fileRule,
			{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "sed:*" }, { toolName: "Grep" }],
				behavior: "allow",
				destination: "session",
			},
			denial,
			mode,
		]);
		expect(sessionRules).toEqual([
			{ rule: "Bash(sed:*)", description: '"sed" commands in this session' },
			{ rule: "Grep", description: "every Grep call in this session" },
		]);
		expect(forSdk).toEqual([fileRule, denial, mode]);
	});
});
