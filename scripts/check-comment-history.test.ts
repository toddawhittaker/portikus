import { describe, expect, test } from "vitest";
// @ts-expect-error The checker is a plain .mjs script with no type declarations.
import { scanText } from "./check-comment-history.mjs";

type Hit = { path: string; line: number; name: string; match: string };
const scan = (path: string, src: string): Hit[] => scanText(path, src);
const matches = (path: string, src: string) => scan(path, src).map((h) => h.match);

describe("history in comments is found", () => {
	test.each([
		["// fixed in #123", "#123"],
		["// see issue 45", "issue 45"],
		["// landed in PR 12", "PR 12"],
		["// added by Epic 19", "Epic 19"],
		["// from task T3", "task T3"],
		["// per ruling S7", "ruling S7"],
		["// review Q3 asked for this", "review Q3"],
		["// docs/archive/epics/EPIC-13.md", "docs/archive/epics"],
		["// see EPIC-29", "EPIC-2"],
	])("%s", (src, want) => {
		expect(matches("a.ts", src)).toEqual([want]);
	});

	test("block comments report the line of the hit", () => {
		const hits = scan("a.css", "a {}\n/* one\n   two (issue #240) */\n");
		expect(hits).toMatchObject([{ line: 3, match: "issue #240" }]);
	});

	test("JSX comments are scanned", () => {
		expect(matches("a.tsx", "<div>{/* see #271 */}</div>")).toEqual(["#271"]);
	});

	test("hash comments in shell, YAML and Make files", () => {
		expect(matches("a.sh", "echo hi # see #840")).toEqual(["#840"]);
		expect(matches("a.yml", "# ruling 11\nkey: v")).toEqual(["ruling 11"]);
		expect(matches("Makefile", "# Epic 3\nall:")).toEqual(["Epic 3"]);
		expect(matches("mk/vm.mk", "# PR 4")).toEqual(["PR 4"]);
	});

	test("hash comments in Python, OpenTofu, systemd units and extensionless scripts", () => {
		expect(matches("a.py", "x = 1  # see #12")).toEqual(["#12"]);
		expect(matches("main.tf", "# Epic 2\nresource {}")).toEqual(["Epic 2"]);
		expect(matches("a.service", "# PR 7\n[Unit]")).toEqual(["PR 7"]);
		expect(matches("a.timer", "# issue 9")).toEqual(["issue 9"]);
		expect(matches("packaging/scripts/postinst", "#!/bin/sh\n# see #77")).toEqual([
			"#77",
		]);
		expect(matches("packaging/registry/registry-job", "# ruling 3")).toEqual([
			"ruling 3",
		]);
	});

	test("Jinja comments", () => {
		expect(matches("t.conf.j2", "{# issue #12 #}\nx")).toEqual(["issue #12"]);
	});

	test("test titles in test files", () => {
		expect(matches("a.test.ts", 'test("keeps it (issue #934)", () => {});')).toEqual([
			"issue #934",
		]);
		expect(matches("a.spec.ts", "describe(`old pastes (#885)`, () => {});")).toEqual([
			"#885",
		]);
	});

	test("a short all-digit colour in a comment reads as an issue number", () => {
		expect(matches("a.css", "/* was #333 */")).toEqual(["#333"]);
	});

	test("one hit per line", () => {
		expect(scan("a.ts", "// issue #1 and PR 2")).toHaveLength(1);
	});
});

describe("legitimate text is left alone", () => {
	test.each([
		["hex colours", "/* text is #333333 on #fff */ a { color: #000; }", "a.css"],
		["the shebang", "#!/usr/bin/env bash\n", "a.sh"],
		["HTML entities", "// encodes + as &#43; in the query", "a.ts"],
		["ADR 0034 rulings", "// ADR 0034 ruling 3 says so", "a.ts"],
		["section citations", "// SPEC.md section 29 and ADR 0038", "a.ts"],
		["ordinary words", "// the review queue and the task list", "a.ts"],
		["a URL in a string", 'const u = "https://x/issue 4";', "a.ts"],
		["history-like text in a string", 'const s = "Epic 9 #123";', "a.ts"],
		["test titles outside test files", 'test("issue #1")', "a.ts"],
		["Markdown, not scanned", "# Epic 3", "README.md"],
		["design mockups, mirrored from outside", "/* Epic 10 */", "design/x.css"],
		["a YAML value holding #", "color: '#123'", "a.yml"],
	])("%s", (_name, src, path) => {
		expect(scan(path, src)).toEqual([]);
	});
});
