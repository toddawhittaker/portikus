/**
 * The platform's agent instructions are system files rewritten at every
 * start from one template (SPEC.md §3).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
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
	const SETTINGS = '{"env": {"BROWSER": ""}}';
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
});
