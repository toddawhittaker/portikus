/**
 * The platform's agent instructions are system files rewritten at every
 * start from one template (SPEC.md §3).
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_USAGE_PORT, TERMINAL_QUESTION_TIMEOUT_MS } from "@portikus/contracts";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, test } from "vitest";
import {
	AGENT_SCRIPTS_DIR,
	CLAUDE_MANAGED_SETTINGS_PATH,
	CLAUDE_SYSTEM_PATH,
	CODEX_SYSTEM_PATH,
	codexSystemConfig,
	writeAgentInstructions,
	writeClaudeManagedSettings,
} from "./agent-instructions.js";
import { FakeFiles } from "./fake-files.js";

const TEMPLATE = 'Use "portikus-open".\nA \\ backslash.\n';

let files: FakeFiles;
let templatePath: string;

beforeEach(() => {
	files = new FakeFiles();
	files.files.set("/etc/claude-code", { type: "directory", content: "" });
	files.files.set("/etc/codex", { type: "directory", content: "" });
	templatePath = join(mkdtempSync(join(tmpdir(), "agent-instructions-")), "t.md");
	writeFileSync(templatePath, TEMPLATE);
});

describe("writeAgentInstructions", () => {
	test("writes both system files, root-owned and 0644", async () => {
		expect(await writeAgentInstructions(files, "ws-a", templatePath)).toBe(true);
		expect(files.files.get(CLAUDE_SYSTEM_PATH)).toEqual({
			type: "file",
			content: TEMPLATE,
			mode: "0644",
			uid: 0,
		});
		expect(files.files.get(CODEX_SYSTEM_PATH)?.content).toBe(
			codexSystemConfig(TEMPLATE),
		);
		expect(files.files.get(CODEX_SYSTEM_PATH)?.mode).toBe("0644");
	});

	test("an edited file is rewritten at the next start", async () => {
		files.files.set(CLAUDE_SYSTEM_PATH, { type: "file", content: "edited" });
		files.files.set(CODEX_SYSTEM_PATH, { type: "file", content: "edited" });
		await writeAgentInstructions(files, "ws-a", templatePath);
		expect(files.files.get(CLAUDE_SYSTEM_PATH)?.content).toBe(TEMPLATE);
		expect(files.files.get(CODEX_SYSTEM_PATH)?.content).toBe(
			codexSystemConfig(TEMPLATE),
		);
	});

	test("a deleted file and folder come back", async () => {
		files.files.clear();
		await writeAgentInstructions(files, "ws-a", templatePath);
		expect(files.files.get("/etc/claude-code")?.type).toBe("directory");
		expect(files.files.get(CLAUDE_SYSTEM_PATH)?.content).toBe(TEMPLATE);
		expect(files.files.get(CODEX_SYSTEM_PATH)?.content).toBe(
			codexSystemConfig(TEMPLATE),
		);
	});

	test("a host without the template writes nothing", async () => {
		const missing = join(tmpdir(), "no-such-dir-e28i", "t.md");
		expect(await writeAgentInstructions(files, "ws-a", missing)).toBe(false);
		expect(files.files.has(CLAUDE_SYSTEM_PATH)).toBe(false);
	});

	test("a named pipe, link or other type is deleted then written, never opened", async () => {
		for (const type of ["fifo", "symlink", "socket"]) {
			files.ops = [];
			files.files.set(CLAUDE_SYSTEM_PATH, { type, content: "" });
			files.files.set(CODEX_SYSTEM_PATH, { type, content: "" });
			expect(await writeAgentInstructions(files, "ws-a", templatePath)).toBe(true);
			expect(files.ops).toEqual([
				"POST /etc/claude-code",
				`DELETE ${CLAUDE_SYSTEM_PATH}`,
				`POST ${CLAUDE_SYSTEM_PATH}`,
				"POST /etc/codex",
				`DELETE ${CODEX_SYSTEM_PATH}`,
				`POST ${CODEX_SYSTEM_PATH}`,
			]);
			expect(files.files.get(CLAUDE_SYSTEM_PATH)?.content).toBe(TEMPLATE);
		}
	});

	test("a directory at the file path is refused", async () => {
		files.files.set(CLAUDE_SYSTEM_PATH, { type: "directory", content: "" });
		files.files.set(`${CLAUDE_SYSTEM_PATH}/x`, { type: "file", content: "" });
		await expect(writeAgentInstructions(files, "ws-a", templatePath)).rejects.toThrow(
			/cannot be replaced/,
		);
		expect(files.files.get(CLAUDE_SYSTEM_PATH)?.type).toBe("directory");
	});

	test("a pipe where the folder belongs is refused", async () => {
		files.files.set("/etc/claude-code", { type: "fifo", content: "" });
		await expect(writeAgentInstructions(files, "ws-a", templatePath)).rejects.toThrow(
			/not a directory/,
		);
	});

	test("one file that cannot be written does not skip the other", async () => {
		files.files.set("/etc/claude-code", { type: "file", content: "student" });
		await expect(writeAgentInstructions(files, "ws-a", templatePath)).rejects.toThrow(
			CLAUDE_SYSTEM_PATH,
		);
		expect(files.files.get(CODEX_SYSTEM_PATH)?.content).toBe(
			codexSystemConfig(TEMPLATE),
		);
	});
});

describe("writeClaudeManagedSettings", () => {
	const SETTINGS = '{"env": {"BROWSER": "", "DISABLE_AUTOUPDATER": "1"}}';
	let settingsPath: string;

	beforeEach(() => {
		settingsPath = join(mkdtempSync(join(tmpdir(), "managed-settings-")), "s.json");
		writeFileSync(settingsPath, SETTINGS);
	});

	test("writes the settings root-owned and 0644, over an edit", async () => {
		files.files.set(CLAUDE_MANAGED_SETTINGS_PATH, { type: "file", content: "{}" });
		expect(await writeClaudeManagedSettings(files, "ws-a", settingsPath)).toBe(true);
		expect(files.files.get(CLAUDE_MANAGED_SETTINGS_PATH)).toEqual({
			type: "file",
			content: SETTINGS,
			mode: "0644",
			uid: 0,
		});
	});

	test("a deleted /etc/claude-code comes back with the settings", async () => {
		files.files.clear();
		await writeClaudeManagedSettings(files, "ws-a", settingsPath);
		expect(files.files.get("/etc/claude-code")?.type).toBe("directory");
		expect(files.files.get(CLAUDE_MANAGED_SETTINGS_PATH)?.content).toBe(SETTINGS);
	});

	test("a host without the template writes nothing", async () => {
		const missing = join(tmpdir(), "no-such-dir-e37", "s.json");
		expect(await writeClaudeManagedSettings(files, "ws-a", missing)).toBe(false);
		expect(files.ops).toEqual([]);
	});

	test("a named pipe, link or other type is deleted then written, never opened", async () => {
		for (const type of ["fifo", "symlink", "socket"]) {
			files.ops = [];
			files.files.set(CLAUDE_MANAGED_SETTINGS_PATH, { type, content: "" });
			await writeClaudeManagedSettings(files, "ws-a", settingsPath);
			expect(files.ops).toEqual([
				"POST /etc/claude-code",
				`DELETE ${CLAUDE_MANAGED_SETTINGS_PATH}`,
				`POST ${CLAUDE_MANAGED_SETTINGS_PATH}`,
			]);
			expect(files.files.get(CLAUDE_MANAGED_SETTINGS_PATH)?.content).toBe(SETTINGS);
		}
	});

	test("a directory at the file path is refused", async () => {
		files.files.set(CLAUDE_MANAGED_SETTINGS_PATH, { type: "directory", content: "" });
		files.files.set(`${CLAUDE_MANAGED_SETTINGS_PATH}/x`, { type: "file", content: "" });
		await expect(
			writeClaudeManagedSettings(files, "ws-a", settingsPath),
		).rejects.toThrow(/cannot be replaced/);
		expect(files.files.get(CLAUDE_MANAGED_SETTINGS_PATH)?.type).toBe("directory");
	});
});

describe("codexSystemConfig", () => {
	test("keeps the update switch and quotes the template as a TOML basic string", () => {
		const config = codexSystemConfig(TEMPLATE);
		expect(config).toContain("check_for_update_on_startup = false\n");
		expect(config).toContain(
			'developer_instructions = "Use \\"portikus-open\\".\\nA \\\\ backslash.\\n"\n',
		);
	});

	test("sends metrics, and only metrics, to the usage receiver as JSON with prompts off", () => {
		const config = codexSystemConfig(TEMPLATE);
		const otel = config.split("\n[otel]\n")[1] ?? "";
		// Every top-level key comes before the table, or TOML would read it as an otel key.
		expect(config.indexOf("developer_instructions")).toBeLessThan(
			config.indexOf("[otel]"),
		);
		expect(otel).toContain("log_user_prompt = false\n");
		expect(otel).toContain('exporter = "none"\n');
		expect(otel).toContain('trace_exporter = "none"\n');
		expect(otel).toContain(
			`metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:${AGENT_USAGE_PORT}/v1/metrics", protocol = "json" } }\n`,
		);
	});

	test("hooks each state event to the state script, with a 5-second backstop", () => {
		const config = codexSystemConfig(TEMPLATE);
		const hooks = config.slice(config.indexOf("[[hooks."));
		expect(config.indexOf("[otel]")).toBeLessThan(config.indexOf("[[hooks."));
		for (const [event, state] of [
			["UserPromptSubmit", "working"],
			["PostToolUse", "working"],
			["PermissionRequest", "needs-input"],
			["Stop", "finished"],
			["Interrupt", "finished"],
			["SessionEnd", "clear"],
		]) {
			expect(hooks).toContain(
				`[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\n` +
					`command = "${AGENT_SCRIPTS_DIR}/portikus-agent-state codex ${state}"\n` +
					"timeout = 5\n",
			);
		}
		// Nothing but hook tables follows the first one.
		expect(hooks.match(/^\[\[hooks\.[A-Za-z]+\]\]$/gm)).toHaveLength(6);
	});

	test("parses as TOML with one command hook per event", () => {
		const parsed = parse(codexSystemConfig(TEMPLATE)) as {
			developer_instructions: string;
			features: Record<string, unknown>;
			hooks: Record<
				string,
				{ hooks: { type: string; command: string; timeout: number }[] }[]
			>;
		};
		expect(parsed.developer_instructions).toBe(TEMPLATE);
		expect(parsed.features.daemon_auto_start).toBe(false);
		const states: Record<string, string> = {
			UserPromptSubmit: "working",
			PostToolUse: "working",
			PermissionRequest: "needs-input",
			Stop: "finished",
			Interrupt: "finished",
			SessionEnd: "clear",
		};
		expect(Object.keys(parsed.hooks).sort()).toEqual(Object.keys(states).sort());
		for (const [event, state] of Object.entries(states)) {
			const groups = parsed.hooks[event];
			expect(groups).toHaveLength(1);
			expect(groups?.[0]?.hooks).toEqual([
				{
					type: "command",
					command: `${AGENT_SCRIPTS_DIR}/portikus-agent-state codex ${state}`,
					timeout: 5,
				},
			]);
		}
	});
});

describe("the shipped template", () => {
	const text = readFileSync(
		join(import.meta.dirname, "../../workspace-agent/agent-instructions.md"),
		"utf8",
	);

	test("carries the platform rules and the preloaded-image advice", () => {
		expect(text).toContain("/usr/local/bin/portikus-open");
		expect(text).toContain("Never commit");
		expect(text).toContain("docker image ls");
		// SPEC.md §24.1: the chat shows local images, so Claude is told where to save them.
		expect(text).toContain("![Home page screenshot](.portikus/images/home.png)");
		expect(text).not.toMatch(/#\d{3}|SPEC|ADR/);
	});
});

describe("the shipped managed settings", () => {
	test("match what the workspace image writes", () => {
		const shipped = readFileSync(
			join(import.meta.dirname, "../../workspace-agent/claude-managed-settings.json"),
			"utf8",
		);
		const recipe = readFileSync(
			join(import.meta.dirname, "../../../infra/workspace-image/portikus.yaml"),
			"utf8",
		);
		const entry =
			recipe.split("- path: /etc/claude-code/managed-settings.json")[1] ?? "";
		const imageContent = entry.split("content: |-\n")[1]?.split("\n")[0]?.trim();
		expect(JSON.parse(shipped)).toEqual(JSON.parse(imageContent ?? ""));
	});

	test("hook every agent state and subagent event to its script, in the background, and wait only for questions", () => {
		const { hooks } = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../workspace-agent/claude-managed-settings.json"),
				"utf8",
			),
		) as {
			hooks: Record<
				string,
				{
					matcher?: string;
					hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
				}[]
			>;
		};
		const question = `${AGENT_SCRIPTS_DIR}/portikus-agent-question`;
		const wired = Object.entries(hooks).flatMap(([event, groups]) =>
			groups.flatMap((group) =>
				group.hooks.map((hook) => {
					// The question hook waits for the browser's answer, up to the limit.
					if (hook.command === question) {
						expect(hook).toEqual({
							type: "command",
							command: question,
							timeout: TERMINAL_QUESTION_TIMEOUT_MS / 1000,
						});
					} else {
						expect(hook).toMatchObject({ type: "command", async: true });
					}
					return `${event} ${group.matcher ?? "*"} ${hook.command}`;
				}),
			),
		);
		const script = `${AGENT_SCRIPTS_DIR}/portikus-agent-state claude`;
		const subagent = `${AGENT_SCRIPTS_DIR}/portikus-agent-subagent`;
		expect(wired.sort()).toEqual(
			[
				`UserPromptSubmit * ${script} working`,
				`PostToolUse * ${script} working`,
				`PreToolUse AskUserQuestion|ExitPlanMode ${script} needs-input`,
				`PermissionRequest * ${script} needs-input`,
				`Notification elicitation_dialog|elicitation_url_dialog ${script} needs-input`,
				`Notification idle_prompt ${script} finished`,
				`Stop * ${script} finished`,
				`StopFailure * ${script} finished`,
				`SessionEnd * ${script} clear`,
				`PreToolUse Agent|Task ${subagent} pre_tool_use`,
				`PostToolUse Agent|Task ${subagent} post_tool_use`,
				`PostToolUseFailure Agent|Task ${subagent} post_tool_use_failure`,
				`SubagentStop * ${subagent} subagent_stop`,
				`UserPromptSubmit * ${subagent} user_prompt_submit`,
				`Stop * ${subagent} stop`,
				`PreToolUse AskUserQuestion ${question}`,
			].sort(),
		);
	});

	test("replace the status line with the limits script", () => {
		const { statusLine } = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../workspace-agent/claude-managed-settings.json"),
				"utf8",
			),
		) as { statusLine: unknown };
		expect(statusLine).toEqual({
			type: "command",
			command: `${AGENT_SCRIPTS_DIR}/portikus-claude-status`,
		});
	});

	test("name only scripts the workspace agent ships", () => {
		const shipped = readFileSync(
			join(import.meta.dirname, "../../workspace-agent/claude-managed-settings.json"),
			"utf8",
		);
		const scripts = new Set(
			[
				...shipped.matchAll(/\/opt\/portikus\/workspace-agent\/scripts\/([a-z-]+)/g),
			].map((m) => m[1] ?? ""),
		);
		expect([...scripts].sort()).toEqual([
			"portikus-agent-question",
			"portikus-agent-state",
			"portikus-agent-subagent",
			"portikus-claude-status",
		]);
		for (const name of scripts) {
			expect(
				statSync(join(import.meta.dirname, "../../workspace-agent/scripts", name))
					.mode & 0o111,
			).not.toBe(0);
		}
	});

	test("export usage metrics to the loopback receiver, and no logs or prompts", () => {
		const { env } = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../workspace-agent/claude-managed-settings.json"),
				"utf8",
			),
		) as { env: Record<string, string> };
		expect(env).toMatchObject({
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${AGENT_USAGE_PORT}`,
			OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
		});
		// Prompt and tool content stay off; their absence is the default.
		for (const key of [
			"OTEL_LOG_USER_PROMPTS",
			"OTEL_LOG_ASSISTANT_RESPONSES",
			"OTEL_LOG_TOOL_DETAILS",
			"OTEL_LOG_TOOL_CONTENT",
			"OTEL_LOG_RAW_API_BODIES",
		]) {
			expect(env).not.toHaveProperty(key);
		}
	});
});
