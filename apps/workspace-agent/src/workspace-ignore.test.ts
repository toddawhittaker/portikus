/**
 * Recovery exclusions: the SPEC.md §15.5 defaults plus `.workspaceignore`
 * in `.gitignore` syntax (ADR 0020).
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	loadRecoveryMatcher,
	recoveryMatcher,
	WORKSPACEIGNORE_LIMIT,
} from "./workspace-ignore.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-wsignore-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("the six default directories are excluded at any depth, and only as directories", () => {
	const matcher = recoveryMatcher("");
	for (const name of [
		"node_modules",
		".venv",
		"dist",
		"build",
		"target",
		"__pycache__",
	]) {
		expect(matcher.excludes(`${name}/`)).toBe(true);
		expect(matcher.excludes(`packages/web/${name}/`)).toBe(true);
		// A file with the same name is not a directory, so it is kept.
		expect(matcher.excludes(name)).toBe(false);
	}
	expect(matcher.excludes(".env")).toBe(false);
	expect(matcher.excludes(".git/")).toBe(false);
	expect(matcher.excludes("src/")).toBe(false);
});

test(".workspaceignore adds patterns and a negation brings a default back", () => {
	const matcher = recoveryMatcher("# data\nbig-data/\n*.log\n!dist/\n");
	expect(matcher.excludes("big-data/")).toBe(true);
	expect(matcher.excludes("src/debug.log")).toBe(true);
	expect(matcher.excludes("dist/")).toBe(false);
	expect(matcher.excludes("node_modules/")).toBe(true);
});

test("the file is read from the project root", async () => {
	await writeFile(join(dir, ".workspaceignore"), "secret/\n");
	const matcher = await loadRecoveryMatcher(dir);
	expect(matcher.excludes("secret/")).toBe(true);
});

test("a missing file leaves the defaults alone", async () => {
	const matcher = await loadRecoveryMatcher(dir);
	expect(matcher.excludes("node_modules/")).toBe(true);
	expect(matcher.excludes("secret/")).toBe(false);
});

test("a symlinked .workspaceignore is not followed", async () => {
	const outside = await mkdtemp(join(tmpdir(), "portikus-wsignore-out-"));
	try {
		await writeFile(join(outside, "rules"), "!node_modules/\nsecret/\n");
		await symlink(join(outside, "rules"), join(dir, ".workspaceignore"));
		const matcher = await loadRecoveryMatcher(dir);
		expect(matcher.excludes("secret/")).toBe(false);
		expect(matcher.excludes("node_modules/")).toBe(true);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("an oversized .workspaceignore is ignored", async () => {
	await writeFile(
		join(dir, ".workspaceignore"),
		`secret/\n${"#".repeat(WORKSPACEIGNORE_LIMIT)}\n`,
	);
	const matcher = await loadRecoveryMatcher(dir);
	expect(matcher.excludes("secret/")).toBe(false);
});
