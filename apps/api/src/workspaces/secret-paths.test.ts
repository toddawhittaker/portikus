import { describe, expect, test } from "vitest";
import { filterGitStatus, filterTree, isSecretPath } from "./secret-paths.js";

/** The secret filter on a shared project (SPEC.md §5.2, ADR 0057). */

describe("isSecretPath", () => {
	test.each([
		".git",
		".git/config",
		"sub/.git/HEAD",
		".env",
		".env.local",
		".env.production",
		"api/.env",
		"server.pem",
		"certs/tls.key",
		"id_rsa",
		"id_rsa.pub",
		"keys/id_ed25519",
		".npmrc",
		".netrc",
		".pypirc",
		".portikus",
		".portikus/checks.json",
		".ENV",
		"Server.PEM",
	])("hides %s", (path) => {
		expect(isSecretPath(path)).toBe(true);
	});

	test.each([
		"",
		".env.example",
		"api/.env.example",
		"src/app.ts",
		".gitignore",
		".github/workflows/ci.yml",
		"environment.ts",
		"keys.txt",
		"monkey.ts",
		"README.md",
		"docs/pem-notes.md",
	])("shows %s", (path) => {
		expect(isSecretPath(path)).toBe(false);
	});
});

test("filterTree drops secret entries by their full path", () => {
	const tree = {
		entries: [
			{ name: ".env", type: "file" as const, size: 1, mtimeMs: 0 },
			{ name: ".env.example", type: "file" as const, size: 1, mtimeMs: 0 },
			{ name: ".git", type: "dir" as const, size: 0, mtimeMs: 0 },
			{ name: "main.py", type: "file" as const, size: 1, mtimeMs: 0 },
		],
		truncated: false,
	};
	expect(filterTree("", tree).entries.map((entry) => entry.name)).toEqual([
		".env.example",
		"main.py",
	]);
	expect(filterTree("src", tree).entries.map((entry) => entry.name)).toEqual([
		".env.example",
		"main.py",
	]);
});

test("filterGitStatus drops an entry whose path or old path is a secret", () => {
	const status = {
		repo: true,
		branch: "main",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [
			{ path: ".env", x: "M", y: ".", unmerged: false },
			{ path: "config.txt", x: "R", y: ".", unmerged: false, origPath: ".env" },
			{ path: "src/app.ts", x: ".", y: "M", unmerged: false },
		],
		ignored: ["node_modules/", ".env.local"],
		truncated: false,
	};
	const filtered = filterGitStatus(status);
	expect(filtered.entries.map((entry) => entry.path)).toEqual(["src/app.ts"]);
	expect(filtered.ignored).toEqual(["node_modules/"]);
	expect(filtered.branch).toBe("main");
});
