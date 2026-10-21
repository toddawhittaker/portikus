/** The language-server table (SPEC.md §13.6). */
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGUAGE_SERVER_IDS } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LANGUAGE_SERVERS, pythonPath, RUFF_PATH } from "./language-server-table.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-lsp-table-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("there is one entry per contract id", () => {
	expect(Object.keys(LANGUAGE_SERVERS).sort()).toEqual([...LANGUAGE_SERVER_IDS].sort());
	for (const [id, entry] of Object.entries(LANGUAGE_SERVERS)) expect(entry.id).toBe(id);
});

test("only python and typescript count toward the cap", () => {
	expect(LANGUAGE_SERVERS.python.counted).toBe(true);
	expect(LANGUAGE_SERVERS.typescript.counted).toBe(true);
	expect(LANGUAGE_SERVERS.ruff.counted).toBe(false);
});

test("ruff starts with lint off", () => {
	expect(LANGUAGE_SERVERS.ruff.initializationOptions).toEqual({
		settings: { lint: { enable: false } },
	});
});

test("typescript cannot be told to fetch types: ATA off, and no configuration requests", () => {
	expect(LANGUAGE_SERVERS.typescript.initializationOptions).toEqual({
		userPreferences: { automaticTypeAcquisitionEnabled: false },
	});
	expect(LANGUAGE_SERVERS.typescript.clientCapabilities).toEqual({
		workspace: { configuration: false },
	});
});

describe("commands", () => {
	test("pyright runs under node with a heap cap", async () => {
		const command = await LANGUAGE_SERVERS.python.resolve(dir);
		expect(command?.command).toBe(process.execPath);
		expect(command?.args[0]).toBe("--max-old-space-size=1024");
		expect(command?.args[1]).toMatch(/pyright[/\\]langserver\.index\.js$/);
		expect(command?.args[2]).toBe("--stdio");
	});

	test("typescript is the native binary in LSP mode with a Go memory limit", async () => {
		const command = await LANGUAGE_SERVERS.typescript.resolve(dir);
		expect(command).not.toBeNull();
		await access(command?.command as string, constants.X_OK);
		expect(command?.args).toEqual(["--lsp", "--stdio"]);
		expect(command?.env).toEqual({ GOMEMLIMIT: "1024MiB" });
	});

	test("ruff is the agent tree's bin/ruff, unavailable when missing", async () => {
		expect(RUFF_PATH).toMatch(/workspace-agent[/\\]bin[/\\]ruff$/);
		const installed = await access(RUFF_PATH, constants.X_OK).then(
			() => true,
			() => false,
		);
		const command = await LANGUAGE_SERVERS.ruff.resolve(dir);
		expect(command === null).toBe(!installed);
		if (command) expect(command.args).toEqual(["server"]);
	});
});

describe("pythonPath", () => {
	test("puts .venv/bin first, then venv/bin, else leaves PATH alone", async () => {
		expect(await pythonPath(dir, "/usr/bin")).toBe("/usr/bin");
		await mkdir(join(dir, "venv", "bin"), { recursive: true });
		expect(await pythonPath(dir, "/usr/bin")).toBe(
			`${join(dir, "venv", "bin")}:/usr/bin`,
		);
		await mkdir(join(dir, ".venv", "bin"), { recursive: true });
		expect(await pythonPath(dir, "/usr/bin")).toBe(
			`${join(dir, ".venv", "bin")}:/usr/bin`,
		);
	});
});
