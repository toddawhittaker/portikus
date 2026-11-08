import type {
	PermissionRuleValue,
	PermissionUpdate,
	PermissionUpdateDestination,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatSessionRule } from "@portikus/contracts";

/**
 * Claude's "Always allow" suggestions in plain English, and the split
 * between the rules the host holds for the session (so the student can
 * revoke them) and the updates the SDK applies itself (SPEC.md §10.8).
 */

/** Longest command or path quoted in a button before it is cut short. */
const MAX_QUOTED_CHARS = 80;

function quoted(text: string): string {
	const short =
		text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS - 1)}…` : text;
	return `"${short}"`;
}

/** The rule in Claude Code's own syntax, such as `Bash(sed:*)`. */
export function ruleText(rule: PermissionRuleValue): string {
	return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** What one rule allows, without where or for how long. */
export function describeRule(rule: PermissionRuleValue): string {
	const content = rule.ruleContent;
	if (!content) return `every ${rule.toolName} call`;
	if (rule.toolName === "Bash") {
		if (content.endsWith(":*")) return `${quoted(content.slice(0, -2))} commands`;
		return `the command ${quoted(content)}`;
	}
	return `${rule.toolName} on ${quoted(content)}`;
}

const HOW_LONG: Record<PermissionUpdateDestination, string> = {
	session: "in this session",
	cliArg: "in this session",
	localSettings: "in this project, saved to your local project settings",
	projectSettings: "in this project, saved to the shared project settings",
	userSettings: "in all your projects, saved to your user settings",
};

const MODE_NAMES: Record<string, string> = {
	acceptEdits: "file edits without asking",
	plan: "plan mode",
	auto: "auto mode",
	bypassPermissions: "every tool without asking",
	default: "the ask-first mode",
};

function describeUpdate(update: PermissionUpdate): string {
	const where = HOW_LONG[update.destination];
	switch (update.type) {
		case "addRules":
			if (update.behavior !== "allow") break;
			return `${update.rules.map(describeRule).join(" and ")} ${where}`;
		case "setMode":
			return `${MODE_NAMES[update.mode] ?? update.mode} ${where}`;
		case "addDirectories":
			return `access to ${update.directories.map(quoted).join(" and ")} ${where}`;
	}
	return `a permission change ${where}`;
}

/** The Always allow button's label, naming every grant and how long it lasts. */
export function alwaysAllowLabel(suggestions: PermissionUpdate[]): string {
	return `Always allow ${suggestions.map(describeUpdate).join("; ")}`;
}

function heldByHost(
	update: PermissionUpdate,
): update is Extract<PermissionUpdate, { type: "addRules" }> {
	return (
		update.type === "addRules" &&
		update.behavior === "allow" &&
		(update.destination === "session" || update.destination === "cliArg")
	);
}

/**
 * Session allow rules go to the host, which applies them through the flag
 * settings layer where it can later take them back; the SDK keeps no way
 * to remove a rule it was handed. Everything else goes to the SDK as is.
 */
export function splitSuggestions(suggestions: PermissionUpdate[]): {
	sessionRules: ChatSessionRule[];
	forSdk: PermissionUpdate[];
} {
	const sessionRules: ChatSessionRule[] = [];
	const forSdk: PermissionUpdate[] = [];
	for (const update of suggestions) {
		if (!heldByHost(update)) {
			forSdk.push(update);
			continue;
		}
		for (const rule of update.rules) {
			sessionRules.push({
				rule: ruleText(rule),
				description: `${describeRule(rule)} in this session`,
			});
		}
	}
	return { sessionRules, forSdk };
}
