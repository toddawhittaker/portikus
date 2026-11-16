import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_SECTION_CHARS, readGuide, searchGuides, splitSections } from "./guides.js";
import { resolveCall } from "./tools.js";

/** The guides the assistant answers from (SPEC.md section 20.5): headings, keyword search, role limits. */

function guideDir(files: Record<string, string>): string[] {
	const dir = mkdtempSync(join(tmpdir(), "guides-"));
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files))
		writeFileSync(join(dir, name), text);
	return [dir];
}

const ADMIN = { role: "administrator", readOnly: true } as const;
const INSTRUCTOR = { role: "instructor", readOnly: false } as const;

describe("splitting a guide at its headings", () => {
	test("each heading starts a section, a code fence hides a '#' line, a repeat is numbered", () => {
		const sections = splitSections(
			"X.md",
			[
				"# Title",
				"intro",
				"## Backups",
				"Run the backup.",
				"```sh",
				"# not a heading",
				"```",
				"## Backups",
				"Second one.",
				"### Empty",
			].join("\n"),
		);
		expect(sections.map((s) => s.heading)).toEqual(["Title", "Backups", "Backups (2)"]);
		expect(sections[1]?.text).toContain("# not a heading");
	});
});

describe("searching the guides", () => {
	const dirs = guideDir({
		"ADMIN-GUIDE.md":
			"# Admin\n## Backups\nPoint the backup at a disk.\n## Other\nNothing.",
		"OPERATIONS.md":
			"# Ops\n## Restore\nA backup restores a dump. Backup backup backup.",
		"INSTRUCTOR-GUIDE.md": "# Instructor\n## Roster\nSync the roster with the LMS.",
	});

	test("a heading match outranks mentions in a body, and a hit names its file and heading", () => {
		const hits = searchGuides("administrator", "how do backups work", dirs);
		expect(hits[0]).toMatchObject({ file: "ADMIN-GUIDE.md", heading: "Backups" });
		expect(hits[1]).toMatchObject({ file: "OPERATIONS.md", heading: "Restore" });
		expect(hits[0]?.excerpt).toMatch(/backup/i);
	});

	test("a query of only filler words finds nothing, and at most five sections come back", () => {
		expect(searchGuides("administrator", "the and how", dirs)).toEqual([]);
		const many = guideDir({
			"ADMIN-GUIDE.md": Array.from(
				{ length: 9 },
				(_, i) => `## Topic ${i}\nwidget`,
			).join("\n"),
		});
		expect(searchGuides("administrator", "widget", many)).toHaveLength(5);
	});

	test("an instructor searches and reads the instructor guide only", () => {
		const hits = searchGuides("instructor", "backup roster", dirs);
		expect(hits.map((h) => h.file)).toEqual(["INSTRUCTOR-GUIDE.md"]);
		expect(readGuide("instructor", "ADMIN-GUIDE.md", "Backups", dirs)).toMatchObject({
			found: false,
			message: expect.stringMatching(/no guide named ADMIN-GUIDE\.md/),
		});
		expect(
			readGuide("administrator", "INSTRUCTOR-GUIDE.md", "roster", dirs),
		).toMatchObject({ found: true, heading: "Roster" });
	});
});

describe("reading a section", () => {
	test("returns the text, caps a long one, and says what is wrong with a bad name", () => {
		const dirs = guideDir({
			"ADMIN-GUIDE.md": `## Long\n${"x".repeat(MAX_SECTION_CHARS + 50)}\n## Short\nhello`,
		});
		const short = readGuide("administrator", "ADMIN-GUIDE.md", "Short", dirs);
		expect(short).toEqual({
			found: true,
			file: "ADMIN-GUIDE.md",
			heading: "Short",
			text: "hello",
		});
		const long = readGuide("administrator", "ADMIN-GUIDE.md", "Long", dirs);
		expect(long.found && long.text).toMatch(/\[Truncated: the section is/);
		expect(readGuide("administrator", "ADMIN-GUIDE.md", "Nope", dirs)).toMatchObject({
			found: false,
			message: expect.stringMatching(/no section headed "Nope"/),
		});
		expect(readGuide("administrator", "OPERATIONS.md", "x", dirs)).toMatchObject({
			found: false,
			message: expect.stringMatching(/The guides are: ADMIN-GUIDE\.md/),
		});
	});

	test("with no guide installed it says so", () => {
		expect(
			readGuide("administrator", "ADMIN-GUIDE.md", "x", guideDir({})),
		).toMatchObject({
			message: expect.stringMatching(/none installed/),
		});
	});
});

describe("the guide tools as the model calls them", () => {
	test("search and read answer at once from the repository's own guides", () => {
		const found = resolveCall(
			{ name: "guide_search", input: { query: "second factor sign in" } },
			ADMIN,
		);
		if (found.kind !== "answer") throw new Error("expected an answer");
		const { sections } = JSON.parse(found.text) as {
			sections: { file: string; heading: string }[];
		};
		expect(sections.length).toBeGreaterThan(0);
		const first = sections[0];
		const read = resolveCall(
			{ name: "guide_read", input: { file: first?.file, heading: first?.heading } },
			ADMIN,
		);
		expect(read).toMatchObject({ kind: "answer", isError: false });
		expect(read.kind === "answer" && JSON.parse(read.text)).toMatchObject({
			found: true,
			heading: first?.heading,
		});
	});

	test("an instructor's search never returns an administrator guide", () => {
		const found = resolveCall(
			{ name: "guide_search", input: { query: "backup restore install certificate" } },
			INSTRUCTOR,
		);
		if (found.kind !== "answer") throw new Error("expected an answer");
		const { sections } = JSON.parse(found.text) as { sections: { file: string }[] };
		for (const section of sections) expect(section.file).toBe("INSTRUCTOR-GUIDE.md");
	});

	test("bad arguments and unknown sections come back as errors", () => {
		expect(resolveCall({ name: "guide_search", input: {} }, ADMIN)).toMatchObject({
			kind: "answer",
			isError: true,
			text: expect.stringMatching(/VALIDATION_FAILED/),
		});
		expect(
			resolveCall({ name: "guide_read", input: { file: "x" } }, ADMIN),
		).toMatchObject({
			kind: "answer",
			isError: true,
			text: expect.stringMatching(/VALIDATION_FAILED/),
		});
		expect(
			resolveCall(
				{
					name: "guide_read",
					input: { file: "ADMIN-GUIDE.md", heading: "No such heading" },
				},
				ADMIN,
			),
		).toMatchObject({
			kind: "answer",
			isError: true,
			text: expect.stringMatching(/NOT_FOUND/),
		});
	});
});
