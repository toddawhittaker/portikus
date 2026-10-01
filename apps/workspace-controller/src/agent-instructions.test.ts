/**
 * The platform's agent instructions are system files rewritten at every
 * start from one template (SPEC.md §3, issue #933).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
	CLAUDE_SYSTEM_PATH,
	CODEX_SYSTEM_PATH,
	codexSystemConfig,
	writeAgentInstructions,
} from "./agent-instructions.js";
import { IncusError } from "./incus.js";

type Entry = { type: string; content: string; mode?: string; uid?: number };

/**
 * A container's files as the Incus files API treats them. It has no
 * readFile on purpose: opening a named pipe would block the controller.
 */
class FakeFiles {
	files = new Map<string, Entry>();
	ops: string[] = [];

	async deleteFile(_instance: string, path: string) {
		const entry = this.files.get(path);
		if (!entry) throw new IncusError("NOT_FOUND", "not found");
		const children = [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
		if (entry.type === "directory" && children) {
			throw new IncusError("OPERATION_FAILED", "directory not empty");
		}
		this.ops.push(`DELETE ${path}`);
		this.files.delete(path);
	}

	async pushFile(
		_instance: string,
		path: string,
		body: string,
		opts: { uid: number; mode: string; type?: "file" | "directory" },
	) {
		const entry = this.files.get(path);
		// Incus answers success for a folder push onto any existing path.
		if (opts.type === "directory" && entry) {
			this.ops.push(`POST ${path}`);
			return;
		}
		const parent = this.files.get(path.slice(0, path.lastIndexOf("/")));
		if (parent && parent.type !== "directory") {
			throw new IncusError("OPERATION_FAILED", "not a directory");
		}
		if (opts.type !== "directory" && entry && entry.type !== "file") {
			throw new Error(`test: pushed onto a ${entry.type}, which would block or follow`);
		}
		this.ops.push(`POST ${path}`);
		this.files.set(path, {
			type: opts.type ?? "file",
			content: body,
			mode: opts.mode,
			uid: opts.uid,
		});
	}
}

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

	test("carries the platform rules and the preloaded-image advice (#932)", () => {
		expect(text).toContain("/usr/local/bin/portikus-open");
		expect(text).toContain("Never commit");
		expect(text).toContain("docker image ls");
		expect(text).not.toMatch(/#\d{3}|SPEC|ADR/);
	});
});
