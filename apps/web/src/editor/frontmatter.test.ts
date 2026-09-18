/** Frontmatter is only a block at the very top of the file (SPEC.md §13.4). */
import { expect, test } from "vitest";
import { splitFrontmatter } from "./frontmatter.js";

test("a YAML block at the top is frontmatter", () => {
	const result = splitFrontmatter("---\ntitle: Notes\n---\n# Heading\n");
	expect(result).toEqual({ frontmatter: "title: Notes", body: "# Heading\n" });
});

test("a TOML block at the top is frontmatter", () => {
	const result = splitFrontmatter('+++\ntitle = "Notes"\n+++\nbody\n');
	expect(result.frontmatter).toBe('title = "Notes"');
	expect(result.body).toBe("body\n");
});

test("a file with no frontmatter is all body", () => {
	const result = splitFrontmatter("# Heading\n\nSome text.\n");
	expect(result).toEqual({ frontmatter: null, body: "# Heading\n\nSome text.\n" });
});

test("a rule in the middle of the document is not frontmatter", () => {
	const text = "# Heading\n\n---\n\nmore\n";
	expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
});

test("CRLF line endings still split", () => {
	const result = splitFrontmatter("---\r\ntitle: Notes\r\n---\r\n# Heading\r\n");
	expect(result.frontmatter).toBe("title: Notes");
	expect(result.body).toBe("# Heading\r\n");
});

test("a closing fence with trailing spaces still closes the block", () => {
	const result = splitFrontmatter("---\ntitle: Notes\n---   \n# Heading\n");
	expect(result.frontmatter).toBe("title: Notes");
	expect(result.body).toBe("# Heading\n");
});

test("an unclosed fence leaves the whole file as the body", () => {
	const text = "---\ntitle: Notes\n# Heading\n";
	expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
});

test("an empty frontmatter block leaves nothing to show", () => {
	const result = splitFrontmatter("---\n---\nbody\n");
	expect(result.frontmatter).toBe("");
	expect(result.body).toBe("body\n");
});
