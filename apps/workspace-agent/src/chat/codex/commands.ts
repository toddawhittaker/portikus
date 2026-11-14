import { ChatCommand, MAX_CHAT_COMMANDS } from "@portikus/contracts";
import type { SkillsList } from "./protocol.js";

/**
 * The commands a Codex chat offers. App-server reports no slash commands,
 * so the list is fixed: the ones the chat runs, then the ones only the
 * terminal Codex can run, shown dimmed. The student's skills follow with
 * Codex's own `$` prefix.
 */
const RUNS: Omit<ChatCommand, "terminalOnly">[] = [
	{ name: "model", description: "Choose the model", argumentHint: "[model]" },
	{
		name: "effort",
		description: "Choose how hard Codex thinks",
		argumentHint: "[effort]",
	},
	{
		name: "permissions",
		description: "Choose what Codex may do without asking",
		argumentHint: "[mode]",
	},
	{
		name: "plan",
		description: "Plan before changing anything",
		argumentHint: "[prompt]",
	},
	{ name: "compact", description: "Summarize the conversation to free up context" },
	{ name: "new", description: "Start a new conversation" },
	{ name: "clear", description: "Start a new conversation" },
	{ name: "rename", description: "Rename the conversation", argumentHint: "<title>" },
	{
		name: "review",
		description: "Review your uncommitted changes",
		argumentHint: "[instructions]",
	},
	{ name: "mcp", description: "Show your MCP servers" },
];

const TERMINAL_ONLY: Omit<ChatCommand, "terminalOnly">[] = [
	{ name: "resume", description: "Resume an earlier conversation" },
	{ name: "fork", description: "Fork this conversation" },
	{ name: "status", description: "Show the session's settings and usage" },
	{ name: "diff", description: "Show the Git diff" },
	{ name: "init", description: "Create an AGENTS.md file" },
	{ name: "plugins", description: "Browse plugins" },
	{ name: "logout", description: "Sign out of Codex" },
];

/** The names of the commands the chat itself runs. */
const RUNNABLE_COMMANDS = new Set(RUNS.map((command) => command.name));

const MAX_DESCRIPTION_CHARS = 200;

/** The enabled skills, once each, as `$name` commands. */
function skillCommands(skills: SkillsList): ChatCommand[] {
	const listed: ChatCommand[] = [];
	for (const entry of skills.data) {
		for (const skill of entry.skills) {
			if (!skill.enabled || listed.some((known) => known.name === skill.name)) continue;
			const description =
				skill.interface?.shortDescription ??
				skill.shortDescription ??
				skill.description ??
				"";
			const command = ChatCommand.safeParse({
				name: skill.name,
				description: description.slice(0, MAX_DESCRIPTION_CHARS),
				terminalOnly: false,
				prefix: "$",
			});
			if (command.success) listed.push(command.data);
		}
	}
	return listed;
}

export function codexCommands(skills: SkillsList | null): ChatCommand[] {
	return [
		...RUNS.map((command) => ({ ...command, terminalOnly: false })),
		...TERMINAL_ONLY.map((command) => ({ ...command, terminalOnly: true })),
		...(skills ? skillCommands(skills) : []),
	].slice(0, MAX_CHAT_COMMANDS);
}

/** A typed `/name rest` the chat runs itself, or null for anything else. */
export function slashCommand(text: string): { name: string; rest: string } | null {
	const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match || !RUNNABLE_COMMANDS.has(match[1] as string)) return null;
	return { name: match[1] as string, rest: (match[2] ?? "").trim() };
}
