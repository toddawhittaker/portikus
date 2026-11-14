import type {
	ChatCommand,
	ChatMcpServer,
	ChatModeInfo,
	ChatModelInfo,
	ChatOpenCard,
} from "@portikus/contracts";

/**
 * What the fake chat host says and shows: the fixed cards, lists and text
 * of its scripted turns, for Claude and for Codex (SPEC.md §10.8).
 */

/** A 1 by 1 pixel PNG, small enough to sit inside a frame. */
export const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const FINAL_MARKDOWN = [
	"Here is the **plan**.",
	"",
	"```ts",
	"export const answer = 42;",
	"```",
	"",
	"See [the docs](https://example.com/docs).",
	"",
	"![remote pixel](https://example.com/pixel.png)",
].join("\n");

export const QUESTION_CARD: Extract<ChatOpenCard, { type: "question" }> = {
	type: "question",
	id: "card-question",
	questions: [
		{
			question: "Which checks should run?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "Style rules" },
				{ label: "Tests", description: "Unit tests" },
				{ label: "Types", description: "Type checking" },
			],
		},
		{
			question: "Which layout?",
			header: "Layout",
			multiSelect: false,
			options: [
				{ label: "Tabs", description: "One tab per file", preview: "+----+----+" },
				{ label: "Tree", description: "A folder tree", preview: "|- src\n|- test" },
			],
		},
	],
};

export const PERMISSION_CARD: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "card-permission",
	toolName: "Bash",
	title: "Run npm test",
	input: { command: "npm test" },
	options: [
		{ id: "allow", label: "Allow once", decision: "allowed" },
		{
			id: "always",
			label: "Always allow npm test commands for this chat",
			decision: "allowedAlways",
		},
		{ id: "deny", label: "Deny", decision: "denied" },
	],
};

/** Claude Code's MCP tool name: `mcp__<server>__<tool>`. */
export const CLAUDE_MCP_CARD: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "card-mcp",
	toolName: "mcp__github__search_issues",
	title: "Allow github to run search_issues?",
	input: { query: "is:open label:bug" },
	options: [
		{ id: "allow", label: "Allow once", decision: "allowed" },
		{ id: "always", label: "Allow for this chat", decision: "allowedAlways" },
		{ id: "deny", label: "Deny", decision: "denied" },
	],
};

export const CODEX_MCP_CARD: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "cx-mcp",
	toolName: "mcpToolCall",
	title: "Allow github to run search_issues?",
	input: { server: "github", tool: "search_issues", arguments: { query: "is:open" } },
	options: [
		{ id: "allow", label: "Allow", decision: "allowed" },
		{ id: "session", label: "Allow for this chat", decision: "allowedAlways" },
		{ id: "deny", label: "Deny", decision: "denied" },
	],
};

const CODEX_PLAN = [
	"1. Read the failing test.",
	"2. Fix the answer in `src/answer.ts`.",
	"3. Run the tests.",
].join("\n");

/** Codex's plan card: a permission card that carries the plan. */
export const CODEX_PLAN_CARD: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "cx-plan",
	toolName: "plan",
	title: "Implement this plan?",
	input: {},
	plan: CODEX_PLAN,
	options: [
		{ id: "implement", label: "Implement the plan", decision: "allowed" },
		{ id: "keep", label: "Keep planning", decision: "denied" },
	],
};

/** Codex's questions may have no options, or ask for a secret. */
export const CODEX_QUESTION_CARD: Extract<ChatOpenCard, { type: "question" }> = {
	type: "question",
	id: "cx-question",
	questions: [
		{
			question: "Which branch should I use?",
			header: "Branch",
			multiSelect: false,
			options: [],
		},
		{
			question: "What is the deploy token?",
			header: "Token",
			multiSelect: false,
			options: [],
			secret: true,
		},
	],
};

/** What a host says when an MCP server asks for a form the chat cannot show. */
export const ELICITATION_NOTICE =
	"A tool asked for input in a form the chat cannot show, so it was declined. Use a terminal tab for that tool.";

/** When the fake's earlier turn began, in epoch milliseconds. */
export const EARLIER_TURN_AT = Date.UTC(2026, 0, 1, 12, 0, 0);

/** The command list a fake chat starts with; a test can replace it. */
export const DEFAULT_COMMANDS: ChatCommand[] = [
	{
		name: "compact",
		description: "Free up context by summarizing the chat",
		terminalOnly: false,
	},
	{
		name: "review",
		description: "Review a pull request",
		argumentHint: "<pull request>",
		terminalOnly: false,
	},
	{ name: "mcp", description: "Show your MCP servers", terminalOnly: false },
	{ name: "config", description: "Open the settings menu", terminalOnly: true },
	{
		name: "pdf",
		description: "Read and fill in PDF files",
		terminalOnly: false,
		prefix: "/",
	},
];

/**
 * Codex has no commands of its own over its app-server, so its host keeps a
 * fixed list: these run in the chat, the rest are for a terminal, and the
 * student's skills come with a `$`.
 */
export const CODEX_COMMANDS: ChatCommand[] = [
	...[
		["model", "Choose the model"],
		["effort", "Choose the reasoning effort"],
		["permissions", "Choose what Codex may do without asking"],
		["plan", "Plan before changing anything"],
		["compact", "Free up context by summarizing the chat"],
		["new", "Start a new chat"],
		["clear", "Clear the chat"],
		["rename", "Rename this chat"],
		["review", "Review your changes"],
		["mcp", "Show your MCP servers"],
	].map(([name, description]) => ({
		name: name ?? "",
		description: description ?? "",
		terminalOnly: false,
	})),
	...[
		["resume", "Resume an earlier chat"],
		["fork", "Fork this chat"],
		["status", "Show the session status"],
		["diff", "Show the Git diff"],
		["init", "Create an AGENTS.md file"],
		["plugins", "Manage plugins"],
		["logout", "Sign out of Codex"],
	].map(([name, description]) => ({
		name: name ?? "",
		description: description ?? "",
		terminalOnly: true,
	})),
	{
		name: "pdf",
		description: "Read and fill in PDF files",
		terminalOnly: false,
		prefix: "$",
	},
];

export const DEFAULT_MCP: ChatMcpServer[] = [
	{ name: "github", status: "connected" },
	{ name: "docs", status: "needsAuth" },
];

export const CLAUDE_MODES: ChatModeInfo[] = [
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

export const CODEX_MODES: ChatModeInfo[] = [
	{
		id: "untrusted",
		label: "Ask",
		description: "Asks before it runs anything it does not know is safe.",
		warning: false,
		plan: false,
	},
	{
		id: "readOnly",
		label: "Read only",
		description: "Reads files and answers. Asks before it changes anything.",
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
		id: "onRequest",
		label: "Auto",
		description: "Works in the workspace on its own. Asks when it needs more.",
		warning: false,
		plan: false,
	},
	{
		id: "fullAccess",
		label: "Full access",
		description: "Full access lets Codex run every command without asking you first.",
		warning: true,
		plan: false,
	},
];

/** The models a fake chat offers, shaped like Claude Code's own list. */
const row = (
	value: string,
	displayName: string,
	description: string,
	resolvedModel = value,
	supportsAutoMode = true,
): ChatModelInfo => ({
	value,
	resolvedModel,
	displayName,
	description,
	supportsAutoMode,
});

export const DEFAULT_MODELS: ChatModelInfo[] = [
	row(
		"default",
		"Default (recommended)",
		"Opus 5.5 · Best for everyday, complex tasks",
		"claude-opus-5-5",
	),
	row("opus", "Opus 5.5", "For complex work and everyday tasks", "claude-opus-5-5"),
	row("fable", "Fable 5.2", "For your toughest challenges", "claude-fable-5-2"),
	row("sonnet", "Sonnet 5.5", "Most efficient for simpler tasks", "claude-sonnet-5-5"),
	row("haiku", "Haiku 5.5", "Fastest for quick answers", "claude-haiku-5-5"),
	row("claude-fable-5-1", "Fable 5.1", "Most capable for your hardest tasks"),
	row(
		"claude-haiku-4-5-20251001",
		"Haiku 4.5",
		"Fastest for quick answers",
		undefined,
		false,
	),
	row("claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
	row("claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks"),
	row("claude-opus-4-7", "Opus 4.7", "Best for everyday, complex tasks"),
	row("claude-sonnet-4-6", "Sonnet 4.6", "Efficient for routine tasks"),
];

/** The models a fake Codex chat offers; each lists its own efforts. */
const codexRow = (
	value: string,
	displayName: string,
	description: string,
	efforts: string[],
): ChatModelInfo => ({
	value,
	resolvedModel: value,
	displayName,
	description,
	supportsAutoMode: true,
	efforts,
	defaultEffort: "medium",
});

export const CODEX_MODELS: ChatModelInfo[] = [
	codexRow("gpt-5.5", "GPT-5.5", "Frontier model for complex coding", [
		"low",
		"medium",
		"high",
		"xhigh",
		"ultra",
	]),
	codexRow("gpt-5.4", "GPT-5.4", "Strong model for everyday coding", [
		"low",
		"medium",
		"high",
		"xhigh",
	]),
	codexRow("gpt-5.4-mini", "GPT-5.4 mini", "Small, fast, and cheaper", [
		"low",
		"medium",
		"high",
	]),
];
