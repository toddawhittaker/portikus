import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { afterWrite } from "./files-route.js";
import { PORTIKUS_IGNORE_LINES } from "./project-files.js";

let home: string;
let project: string;
const warn = vi.fn();
const log = { warn } as unknown as FastifyBaseLogger;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "portikus-after-write-"));
	project = join(home, "projects", "demo");
	await mkdir(join(project, ".git"), { recursive: true });
	warn.mockClear();
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const exclude = () => join(project, ".git", "info", "exclude");

// SPEC.md §7.2: an older Git project gets the exclude lines on its first
// write under .portikus/.
test("a write under .portikus/ adds the Git exclude lines", async () => {
	await afterWrite(log, home, "demo", ".portikus/notes.md");
	const text = await readFile(exclude(), "utf8");
	expect(text).toContain(PORTIKUS_IGNORE_LINES[0]);
});

test("a write elsewhere leaves the exclude file alone", async () => {
	await afterWrite(log, home, "demo", "src/index.ts");
	await expect(readFile(exclude(), "utf8")).rejects.toThrow();
});

// SPEC.md §9.6: pastes older than 7 days go on the next paste in that project.
test("a paste removes pastes past the 7-day cap and keeps newer ones", async () => {
	const pastes = join(project, ".portikus", "pastes");
	await mkdir(pastes, { recursive: true });
	const old = "2026-01-01T00-00-00.png";
	const fresh = "2026-10-01T00-00-00.png";
	await writeFile(join(pastes, old), "x");
	await writeFile(join(pastes, fresh), "x");
	const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	await utimes(join(pastes, old), eightDaysAgo, eightDaysAgo);

	await afterWrite(log, home, "demo", `.portikus/pastes/${fresh}`);

	expect(await readdir(pastes)).toEqual([fresh]);
});

test("a failure is logged and never thrown", async () => {
	await expect(
		afterWrite(log, home, "Not A Slug", ".portikus/x"),
	).resolves.toBeUndefined();
	expect(warn).toHaveBeenCalledOnce();
});
