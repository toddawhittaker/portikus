/**
 * Which files the tab shows in a viewer, and where a Markdown image points
 * inside the project (SPEC.md §13.2, §13.4).
 */
import { expect, test } from "vitest";
import { projectImagePath, viewerKind, viewerVersion } from "./viewable.js";

test("a file's etag is its viewer version", () => {
	expect(viewerVersion("W/abc", { size: 9, mtimeMs: 1 })).toBe("W/abc");
});

// A file past the editor limit comes back with no etag, so its size and
// modified time stand in for one and a change on disk is a new address.
test("a large file without an etag is versioned by size and modified time", () => {
	const before = viewerVersion("", { size: 3_000_000, mtimeMs: 100 });
	const after = viewerVersion("", { size: 3_000_000, mtimeMs: 200 });
	expect(before).toBe("3000000-100");
	expect(after).not.toBe(before);
});

test("no etag and no listing entry means no version", () => {
	expect(viewerVersion("", undefined)).toBeUndefined();
});

test("images, SVG and PDF open in a viewer, whatever the case of the extension", () => {
	expect(viewerKind("a.png")).toBe("image");
	expect(viewerKind("dir/Photo.JPG")).toBe("image");
	expect(viewerKind("x.jpeg")).toBe("image");
	expect(viewerKind("x.gif")).toBe("image");
	expect(viewerKind("x.webp")).toBe("image");
	expect(viewerKind("logo.svg")).toBe("svg");
	expect(viewerKind("brief.pdf")).toBe("pdf");
});

test("everything else is not a viewer file", () => {
	expect(viewerKind("notes.md")).toBeNull();
	expect(viewerKind("report.docx")).toBeNull();
	expect(viewerKind("png")).toBeNull();
	// A dotfile's name is not an extension.
	expect(viewerKind("dir/.png")).toBeNull();
	// A dot in a folder name is not the file's extension.
	expect(viewerKind("img.png/readme")).toBeNull();
});

test("a relative image resolves against the Markdown file's own folder", () => {
	expect(projectImagePath("./diagram.png", "docs/guide/README.md")).toBe(
		"docs/guide/diagram.png",
	);
	expect(projectImagePath("diagram.png", "docs/README.md")).toBe("docs/diagram.png");
	expect(projectImagePath("../img/a.png", "docs/guide/README.md")).toBe(
		"docs/img/a.png",
	);
	expect(projectImagePath("img/a.png", "README.md")).toBe("img/a.png");
});

test("a leading slash is the project root", () => {
	expect(projectImagePath("/img/a.png", "docs/README.md")).toBe("img/a.png");
});

test("percent-encoding is decoded and a query or fragment dropped", () => {
	expect(projectImagePath("my%20shot.png?raw=1#top", "README.md")).toBe("my shot.png");
});

test("addresses that are not a path inside the project are not rewritten", () => {
	expect(projectImagePath("https://example.com/a.png", "README.md")).toBeNull();
	expect(projectImagePath("data:image/png;base64,AAAA", "README.md")).toBeNull();
	expect(projectImagePath("javascript:alert(1)", "README.md")).toBeNull();
	expect(projectImagePath("//cdn.example.com/a.png", "README.md")).toBeNull();
	expect(projectImagePath("#anchor", "README.md")).toBeNull();
	expect(projectImagePath("", "README.md")).toBeNull();
	// Climbing above the project root leaves the project.
	expect(projectImagePath("../a.png", "README.md")).toBeNull();
	expect(projectImagePath("../../../etc/passwd", "docs/README.md")).toBeNull();
	// An encoded climb is still a climb.
	expect(projectImagePath("%2e%2e/a.png", "README.md")).toBeNull();
	expect(projectImagePath("bad%zz.png", "README.md")).toBeNull();
	expect(projectImagePath("a%5Cb.png", "README.md")).toBeNull();
	expect(projectImagePath("./", "README.md")).toBeNull();
});
