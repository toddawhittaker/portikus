import { readFile } from "node:fs/promises";
import {
	AGENT_USAGE_METRICS_PATH,
	AGENT_USAGE_PORT,
	CHAT_START_SETTINGS,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";
import { STUDENT_UID } from "./start-setup.js";

/**
 * The coding agents' platform instructions (SPEC.md §3). One
 * template ships in the Portikus package, next to the workspace agent, so a
 * change reaches every workspace at its next start without a new image.
 */
export const AGENT_INSTRUCTIONS_HOST_PATH =
	"/usr/lib/portikus/workspace-agent/agent-instructions.md";

/**
 * Claude Code's managed settings, shipped beside the instructions template.
 * They blank BROWSER so Claude Code offers its paste-code URL (BROWSER-HANDLING.md 19.2).
 * Their env must never set CLAUDE_CODE_ENTRYPOINT: a label Claude Code does
 * not recognize bills students for extra auto-mode classifier calls.
 */
export const CLAUDE_MANAGED_SETTINGS_HOST_PATH =
	"/usr/lib/portikus/workspace-agent/claude-managed-settings.json";

/** Claude Code's managed settings file, which wins over a student's own settings. */
export const CLAUDE_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/** Claude Code's system-wide memory file, read in every session. */
export const CLAUDE_SYSTEM_PATH = "/etc/claude-code/CLAUDE.md";

/** Claude Code's managed agents folder; a same-named agent here replaces a built-in one. */
export const CLAUDE_MANAGED_AGENTS_DIR = "/etc/claude-code/.claude/agents";

/** The platform's Explore agent, which replaces Claude Code's built-in one. */
export const CLAUDE_EXPLORE_AGENT_PATH = `${CLAUDE_MANAGED_AGENTS_DIR}/Explore.md`;

/**
 * Claude Code's built-in Explore is a read-only search that runs on the
 * session's model; this copy runs it on Haiku, which costs far less. Its
 * prompt is a short paraphrase of the built-in's purpose: recheck it against
 * the built-in whenever the shared Claude Code version changes. A managed
 * agent wins over a student's own same-named agent (checked on 2.1.311), so
 * the start removes it again when the student has one.
 */
export const CLAUDE_EXPLORE_AGENT =
	"---\n" +
	"name: Explore\n" +
	"description: Fast read-only search agent for finding files and code. Use it to locate files by pattern, search code for keywords, or answer where something lives. Say how thorough to be: quick, medium, or very thorough.\n" +
	"tools: Glob, Grep, Read, Bash\n" +
	"model: haiku\n" +
	"---\n" +
	"You are a read-only file search specialist. Find what was asked with Glob, Grep and Read, and use Bash only for read-only commands such as ls, find, git status and git log. Never create, edit, move or delete a file. Search broadly first, then narrow down. Report absolute paths and short excerpts, and say plainly when something was not found.\n";

/**
 * Codex's system config layer. A student's own `~/.codex/config.toml` wins
 * over it, so it holds only what a student may change: the image ships it
 * with the update switch.
 */
export const CODEX_SYSTEM_PATH = "/etc/codex/config.toml";

/**
 * Codex's managed config layer, which wins over a student's own config. A
 * student's own `developer_instructions` replaces the platform's when the
 * platform writes it to the system layer, but not from here, and the hooks,
 * the daemon switch and the metrics settings cannot be turned off from
 * `~/.codex` either (checked on Codex 0.167.1, under `codex app-server` and
 * `codex exec`).
 */
export const CODEX_MANAGED_PATH = "/etc/codex/managed_config.toml";

/** The line the image already ships in the Codex system config. */
const CODEX_UPDATE_LINE = "check_for_update_on_startup = false";

/**
 * Each `wait_agent` timeout re-reads the parent's whole conversation, and the
 * older multi-agent toolset fixes it at 30 seconds (openai/codex#41875). The
 * newer toolset takes a floor as well as a default, and the floor matters
 * because the model passes its own short timeouts; a wait still ends when a
 * subagent finishes. 20 minutes stays inside GPT-5.6's 30-minute prompt
 * cache. It sits in the system layer so a student can switch it back with
 * `features.multi_agent_v2 = false` in `~/.codex/config.toml`.
 */
const CODEX_MULTI_AGENT_TABLE =
	"[features.multi_agent_v2]\n" +
	"enabled = true\n" +
	"min_wait_timeout_ms = 1200000\n" +
	"default_wait_timeout_ms = 1200000\n";

/**
 * Codex's metrics go to the workspace agent's loopback receiver as OTLP JSON
 * (ADR 0057). Metrics carry counts and the model, never prompts; logs and
 * traces stay off, and so does the default export to OpenAI's Statsig.
 * Codex has no `[otel]` temporality key; its OTLP exporters default to delta.
 */
const CODEX_OTEL_TABLE =
	"[otel]\n" +
	"log_user_prompt = false\n" +
	'exporter = "none"\n' +
	'trace_exporter = "none"\n' +
	`metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:${AGENT_USAGE_PORT}${AGENT_USAGE_METRICS_PATH}", protocol = "json" } }\n`;

/**
 * Codex runs hooks inside a long-lived app-server daemon that keeps the
 * environment of the first terminal that started it. With the daemon off,
 * hooks run in the session's own process and carry its PORTIKUS_TERMINAL.
 */
const CODEX_FEATURES_TABLE = "[features]\ndaemon_auto_start = false\n";

/** The workspace agent's scripts as a workspace sees them, through the agent bind mount. */
export const AGENT_SCRIPTS_DIR = "/opt/portikus/workspace-agent/scripts";

/**
 * Codex's hooks report the terminal's agent state and its subagents to the
 * workspace agent (SPEC.md §10.8). Each script reads only what it keeps and
 * always exits 0 within a second, so the timeout is only a backstop. A
 * `matcher` limits a hook to one tool: a question in the Codex terminal
 * (`request_user_input`) marks the tab as needing input, and the PostToolUse
 * that follows the answer marks it working again.
 */
const CODEX_HOOKS: { event: string; matcher?: string; script: string }[] = [
	{ event: "UserPromptSubmit", script: "portikus-agent-state codex working" },
	{ event: "UserPromptSubmit", script: "portikus-agent-subagent user_prompt_submit" },
	{
		event: "PreToolUse",
		matcher: "request_user_input",
		script: "portikus-agent-state codex needs-input",
	},
	{ event: "PostToolUse", script: "portikus-agent-state codex working" },
	{ event: "PermissionRequest", script: "portikus-agent-state codex needs-input" },
	{ event: "SubagentStart", script: "portikus-agent-subagent subagent_start" },
	{ event: "SubagentStop", script: "portikus-agent-subagent subagent_stop" },
	{ event: "Stop", script: "portikus-agent-state codex finished" },
	{ event: "Interrupt", script: "portikus-agent-state codex finished" },
	{ event: "SessionEnd", script: "portikus-agent-state codex clear" },
];

const CODEX_HOOK_TABLES = CODEX_HOOKS.map(
	({ event, matcher, script }) =>
		`[[hooks.${event}]]\n` +
		(matcher === undefined ? "" : `matcher = ${JSON.stringify(matcher)}\n`) +
		`[[hooks.${event}.hooks]]\n` +
		'type = "command"\n' +
		`command = "${AGENT_SCRIPTS_DIR}/${script}"\n` +
		"timeout = 5\n",
).join("\n");

/**
 * The Codex system config: the update switch and the multi-agent wait, both
 * of which a student may change.
 * It is rewritten at every start so the instructions and hooks an older
 * start put here do not run a second time beside the managed file's.
 */
export function codexSystemConfig(): string {
	return (
		"# Written by Portikus at every workspace start; edits do not last.\n" +
		`${CODEX_UPDATE_LINE}\n` +
		// A TOML table ends the top-level keys, so it comes last.
		`\n${CODEX_MULTI_AGENT_TABLE}`
	);
}

/**
 * The Codex managed config holding the template and the hooks. A JSON string
 * is a valid TOML basic string.
 */
export function codexManagedConfig(template: string): string {
	return (
		"# Written by Portikus at every workspace start; edits do not last.\n" +
		`developer_instructions = ${JSON.stringify(template)}\n` +
		// A TOML table ends the top-level keys, so the tables come last.
		`\n${CODEX_FEATURES_TABLE}` +
		`\n${CODEX_OTEL_TABLE}` +
		`\n${CODEX_HOOK_TABLES}`
	);
}

type FilesClient = Pick<IncusClient, "pushFile" | "replaceFile">;

const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;
const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;

/**
 * Write the system files from the template, undoing any edit or deletion.
 * Does nothing when the host has no template. Each file is tried on its own,
 * so one that cannot be written does not skip the others; the failures are
 * thrown together afterwards.
 */
export async function writeAgentInstructions(
	client: FilesClient,
	name: string,
	templatePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const template = await readTemplate(templatePath);
	if (template === null) return false;
	const files: [dirs: string[], path: string, body: string][] = [
		[["/etc/claude-code"], CLAUDE_SYSTEM_PATH, template],
		[
			["/etc/claude-code", "/etc/claude-code/.claude", CLAUDE_MANAGED_AGENTS_DIR],
			CLAUDE_EXPLORE_AGENT_PATH,
			CLAUDE_EXPLORE_AGENT,
		],
		// The managed file goes first, so the platform's instructions are never
		// absent; the system file after it clears what an older start left there.
		[["/etc/codex"], CODEX_MANAGED_PATH, codexManagedConfig(template)],
		[["/etc/codex"], CODEX_SYSTEM_PATH, codexSystemConfig()],
	];
	const failures: string[] = [];
	for (const [dirs, path, body] of files) {
		try {
			await writeSystemFile(client, name, dirs, path, body, signal);
		} catch (err) {
			failures.push(`${path}: ${errorMessage(err)}`);
		}
	}
	if (failures.length > 0) throw new Error(failures.join("; "));
	return true;
}

/**
 * Write Claude Code's managed settings from the shipped template, undoing any
 * edit or deletion. Does nothing when the host has no template.
 */
export async function writeClaudeManagedSettings(
	client: FilesClient,
	name: string,
	templatePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const template = await readTemplate(templatePath);
	if (template === null) return false;
	await writeSystemFile(
		client,
		name,
		["/etc/claude-code"],
		CLAUDE_MANAGED_SETTINGS_PATH,
		template,
		signal,
	);
	return true;
}

/** A template's text, or null when the host has none. */
async function readTemplate(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

async function writeSystemFile(
	client: FilesClient,
	name: string,
	dirs: string[],
	path: string,
	body: string,
	signal?: AbortSignal,
): Promise<void> {
	// Incus answers success whatever already sits at the folder path;
	// a non-folder there makes the file push below fail instead.
	for (const dir of dirs) await client.pushFile(name, dir, "", ROOT_DIR, signal);
	await client.replaceFile(name, path, body, ROOT_FILE, signal);
}

/** A student's own Explore agent, which takes the platform's place. */
export const CLAUDE_STUDENT_EXPLORE_PATH = "/home/student/.claude/agents/Explore.md";

/**
 * Remove the platform's Explore agent when the student has their own, so
 * theirs is the one Claude Code runs (SPEC.md §3). The check runs in the
 * running container as the student; a check that fails keeps the platform's
 * copy, the cheaper default. Deleting is safe while running because the
 * student cannot write in the root-owned managed folder. Returns whether it
 * removed the copy.
 */
export async function yieldExploreToStudent(
	client: Pick<IncusClient, "exec" | "deleteFile">,
	name: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const check = await client.exec(
		name,
		["timeout", String(SEED_SECONDS), "test", "-e", CLAUDE_STUDENT_EXPLORE_PATH],
		{ timeoutSeconds: SEED_SECONDS + 5, user: STUDENT_UID, outputMaxBytes: 1024 },
		signal,
	);
	if (check.status !== 0) return false;
	try {
		await client.deleteFile(name, CLAUDE_EXPLORE_AGENT_PATH, signal);
	} catch (err) {
		if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
	}
	return true;
}

/** The student's own Claude Code settings, which the platform seeds once. */
export const CLAUDE_USER_SETTINGS_PATH = "/home/student/.claude/settings.json";

/**
 * Present once the platform has seeded the settings, so a key the student
 * deletes later stays deleted. It holds the seed's version.
 */
export const CLAUDE_SEED_MARKER_PATH = "/home/student/.claude/.portikus-seeded";

const CLAUDE_SEED_VERSION = "1";

/** A settings file past this is left alone; Claude Code's own are a few KiB. */
const CLAUDE_SETTINGS_MAX_BYTES = 64 * 1024;

/** How long each in-container step may take before `timeout` ends it. */
const SEED_SECONDS = 10;

/** Exit 4: seeded before; 3: no settings file; 5: something not a file is there. */
const SEED_READ_SCRIPT =
	'[ -e "$1" ] && exit 4; [ -e "$2" ] || exit 3; [ -f "$2" ] || exit 5; exec head -c "$3" -- "$2"';

/** An empty body leaves the settings as they are and only writes the marker. */
const SEED_WRITE_SCRIPT =
	'umask 077; mkdir -p -- "$(dirname -- "$1")" || exit 1; ' +
	'if [ -n "$3" ]; then printf %s "$3" > "$1.portikus-tmp" || exit 1; ' +
	// A new file is the student's alone; a replaced one keeps its mode.
	'if [ -e "$1" ]; then chmod --reference="$1" -- "$1.portikus-tmp"; fi; ' +
	'mv -f -- "$1.portikus-tmp" "$1" || exit 1; fi; ' +
	'printf "%s\\n" "$4" > "$2"';

/**
 * The settings with the GUI chat's starting model and effort added where the
 * student has none (SPEC.md §10.3), or null when the text is not a JSON
 * object and must be left alone. Null text means no file yet. Keys keep
 * their order, but JSON cannot keep the rest of the layout, so a changed
 * file is written with two-space indents, as Claude Code writes it.
 */
export function seedClaudeSettings(text: string | null): string | null {
	let settings: unknown = {};
	if (text !== null) {
		try {
			settings = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		return null;
	}
	const seeded: Record<string, unknown> = { ...settings };
	seeded.model ??= CHAT_START_SETTINGS.model;
	seeded.effortLevel ??= CHAT_START_SETTINGS.effort;
	if (text !== null && Object.keys(seeded).length === Object.keys(settings).length) {
		return text;
	}
	return `${JSON.stringify(seeded, null, 2)}\n`;
}

/**
 * Seed the student's Claude Code settings with the GUI chat's starting
 * model and effort, once per workspace (SPEC.md §10.3). It runs in the
 * running container as the student, so a link or pipe planted in the home
 * folder reaches nothing the student could not already reach (SPEC.md §24).
 * Returns whether it seeded this time.
 */
export async function seedClaudeUserSettings(
	client: Pick<IncusClient, "exec">,
	name: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const read = await client.exec(
		name,
		[
			"timeout",
			String(SEED_SECONDS),
			"sh",
			"-c",
			SEED_READ_SCRIPT,
			"sh",
			CLAUDE_SEED_MARKER_PATH,
			CLAUDE_USER_SETTINGS_PATH,
			String(CLAUDE_SETTINGS_MAX_BYTES + 1),
		],
		{
			timeoutSeconds: SEED_SECONDS + 5,
			user: STUDENT_UID,
			outputMaxBytes: CLAUDE_SETTINGS_MAX_BYTES,
		},
		signal,
	);
	if (read.tooLarge || (read.status !== 0 && read.status !== 3)) return false;
	const text = read.status === 3 ? null : read.stdout.toString("utf8");
	const seeded = seedClaudeSettings(text);
	if (seeded === null) return false;
	const write = await client.exec(
		name,
		[
			"timeout",
			String(SEED_SECONDS),
			"sh",
			"-c",
			SEED_WRITE_SCRIPT,
			"sh",
			CLAUDE_USER_SETTINGS_PATH,
			CLAUDE_SEED_MARKER_PATH,
			seeded === text ? "" : seeded,
			CLAUDE_SEED_VERSION,
		],
		{ timeoutSeconds: SEED_SECONDS + 5, user: STUDENT_UID, outputMaxBytes: 1024 },
		signal,
	);
	if (write.status !== 0) {
		throw new Error(`seeding Claude Code's settings exited with ${write.status}`);
	}
	return true;
}
