/**
 * Every workspace start points claude and codex at the shared tools
 * (SPEC.md §3), through the Incus files API only (SPEC.md §24.1).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { writeCodingAgentLinks } from "./coding-agent-links.js";
import { FakeFiles } from "./fake-files.js";

const CLAUDE = "/usr/local/bin/claude";
const CODEX = "/usr/local/bin/codex";
const LINK = { type: "symlink", mode: "0777", uid: 0 };

let files: FakeFiles;
let hostBin: string;

beforeEach(() => {
	files = new FakeFiles();
	files.files.set("/usr/local/bin", { type: "directory", content: "" });
	hostBin = join(mkdtempSync(join(tmpdir(), "coding-agents-")), "bin");
	mkdirSync(hostBin);
});

describe("writeCodingAgentLinks", () => {
	test("writes both links, root-owned, to the shared folder", async () => {
		expect(await writeCodingAgentLinks(files, "ws-a", hostBin)).toBe(true);
		expect(files.files.get(CLAUDE)).toEqual({
			...LINK,
			content: "/opt/portikus/coding-agents/bin/claude",
		});
		expect(files.files.get(CODEX)).toEqual({
			...LINK,
			content: "/opt/portikus/coding-agents/bin/codex",
		});
	});

	test("a server without the shared folder changes nothing", async () => {
		expect(await writeCodingAgentLinks(files, "ws-a", join(hostBin, "nope"))).toBe(
			false,
		);
		const notDir = join(hostBin, "file");
		writeFileSync(notDir, "");
		expect(await writeCodingAgentLinks(files, "ws-a", notDir)).toBe(false);
		expect(files.ops).toEqual([]);
	});

	test("writing again over the image's own links is harmless", async () => {
		await writeCodingAgentLinks(files, "ws-a", hostBin);
		expect(await writeCodingAgentLinks(files, "ws-a", hostBin)).toBe(true);
		expect(files.files.get(CLAUDE)?.content).toBe(
			"/opt/portikus/coding-agents/bin/claude",
		);
	});

	test("an old image's file, a student's link or an empty folder is deleted then replaced", async () => {
		files.files.set(CLAUDE, { type: "file", content: "old npm shim" });
		files.files.set(CODEX, { type: "symlink", content: "/home/student/evil" });
		expect(await writeCodingAgentLinks(files, "ws-a", hostBin)).toBe(true);
		expect(files.ops).toEqual([
			"POST /usr/local/bin",
			`DELETE ${CLAUDE}`,
			`POST ${CLAUDE}`,
			`DELETE ${CODEX}`,
			`POST ${CODEX}`,
		]);
		expect(files.files.get(CODEX)?.content).toBe(
			"/opt/portikus/coding-agents/bin/codex",
		);

		files.files.set(CLAUDE, { type: "directory", content: "" });
		await writeCodingAgentLinks(files, "ws-a", hostBin);
		expect(files.files.get(CLAUDE)?.type).toBe("symlink");
	});

	test("a non-empty folder is refused and the other link is still written", async () => {
		files.files.set(CLAUDE, { type: "directory", content: "" });
		files.files.set(`${CLAUDE}/x`, { type: "file", content: "" });
		await expect(writeCodingAgentLinks(files, "ws-a", hostBin)).rejects.toThrow(
			/claude.*cannot be replaced/,
		);
		expect(files.files.get(CLAUDE)?.type).toBe("directory");
		expect(files.files.get(CODEX)?.type).toBe("symlink");
	});

	test("a link at /usr/local/bin is left to the files API, never touched on the host", async () => {
		files.files.set("/usr/local/bin", { type: "symlink", content: "/etc" });
		// This fake refuses to write through a link; real Incus resolves it
		// inside the container. Either way only files-API calls are made.
		await expect(writeCodingAgentLinks(files, "ws-a", hostBin)).rejects.toThrow(
			/not a directory/,
		);
		expect(files.files.get("/usr/local/bin")?.type).toBe("symlink");
	});
});
