import { readFile } from "node:fs/promises";
import { AGENT_USAGE_METRICS_PATH, AGENT_USAGE_PORT } from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import type { IncusClient } from "./incus.js";

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
 */
export const CLAUDE_MANAGED_SETTINGS_HOST_PATH =
	"/usr/lib/portikus/workspace-agent/claude-managed-settings.json";

/** Claude Code's managed settings file, which wins over a student's own settings. */
export const CLAUDE_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/** Claude Code's system-wide memory file, read in every session. */
export const CLAUDE_SYSTEM_PATH = "/etc/claude-code/CLAUDE.md";

/** Codex's system config layer; a pilot test showed it applies developer_instructions. */
export const CODEX_SYSTEM_PATH = "/etc/codex/config.toml";

/** The line the image already ships in the Codex system config. */
const CODEX_UPDATE_LINE = "check_for_update_on_startup = false";

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

/** The workspace agent's scripts as a workspace sees them, through the agent bind mount. */
export const AGENT_SCRIPTS_DIR = "/opt/portikus/workspace-agent/scripts";

/**
 * Codex's hooks report the terminal's agent state to the workspace agent
 * (SPEC.md §10.8). The script throws its input away unread and always
 * exits 0 within a second, so the timeout is only a backstop.
 */
const CODEX_HOOKS: [event: string, state: string][] = [
	["UserPromptSubmit", "working"],
	["PostToolUse", "working"],
	["PermissionRequest", "needs-input"],
	["Stop", "finished"],
	["Interrupt", "finished"],
	["SessionEnd", "clear"],
];

const CODEX_HOOK_TABLES = CODEX_HOOKS.map(
	([event, state]) =>
		`[[hooks.${event}]]\n` +
		`[[hooks.${event}.hooks]]\n` +
		'type = "command"\n' +
		`command = "${AGENT_SCRIPTS_DIR}/portikus-agent-state codex ${state}"\n` +
		"timeout = 5\n",
).join("\n");

/** The Codex system config holding the template. A JSON string is a valid TOML basic string. */
export function codexSystemConfig(template: string): string {
	return (
		"# Written by Portikus at every workspace start; edits do not last.\n" +
		`${CODEX_UPDATE_LINE}\n` +
		`developer_instructions = ${JSON.stringify(template)}\n` +
		// A TOML table ends the top-level keys, so the tables come last.
		`\n${CODEX_OTEL_TABLE}` +
		`\n${CODEX_HOOK_TABLES}`
	);
}

type FilesClient = Pick<IncusClient, "pushFile" | "replaceFile">;

const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;
const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;

/**
 * Write both system files from the template, undoing any edit or deletion.
 * Does nothing when the host has no template. Each file is tried on its own,
 * so one that cannot be written does not skip the other; the failures are
 * thrown together afterwards.
 */
export async function writeAgentInstructions(
	client: FilesClient,
	name: string,
	templatePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	let template: string;
	try {
		template = await readFile(templatePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	const files: [dir: string, path: string, body: string][] = [
		["/etc/claude-code", CLAUDE_SYSTEM_PATH, template],
		["/etc/codex", CODEX_SYSTEM_PATH, codexSystemConfig(template)],
	];
	const failures: string[] = [];
	for (const [dir, path, body] of files) {
		try {
			await writeSystemFile(client, name, dir, path, body, signal);
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
	let template: string;
	try {
		template = await readFile(templatePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	await writeSystemFile(
		client,
		name,
		"/etc/claude-code",
		CLAUDE_MANAGED_SETTINGS_PATH,
		template,
		signal,
	);
	return true;
}

async function writeSystemFile(
	client: FilesClient,
	name: string,
	dir: string,
	path: string,
	body: string,
	signal?: AbortSignal,
): Promise<void> {
	// Incus answers success whatever already sits at the folder path;
	// a non-folder there makes the file push below fail instead.
	await client.pushFile(name, dir, "", ROOT_DIR, signal);
	await client.replaceFile(name, path, body, ROOT_FILE, signal);
}
