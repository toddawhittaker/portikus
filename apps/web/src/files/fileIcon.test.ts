import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileIconName } from "./fileIcon.js";

/** SPEC.md §11.2: a file row says what kind of file it is. */
describe("the file row icon", () => {
	it("picks an icon from the extension", () => {
		expect(fileIconName("app.ts")).toBe("file-code");
		expect(fileIconName("main.PY")).toBe("file-code");
		expect(fileIconName("index.html")).toBe("file-web");
		expect(fileIconName("styles.css")).toBe("file-web");
		expect(fileIconName("data.json")).toBe("file-data");
		expect(fileIconName("compose.yaml")).toBe("file-data");
		expect(fileIconName("README.md")).toBe("file-markdown");
		expect(fileIconName("logo.png")).toBe("file-image");
		expect(fileIconName("bundle.tar.gz")).toBe("file-archive");
		expect(fileIconName("settings.ini")).toBe("file-config");
	});

	it("picks an icon from a well-known name", () => {
		expect(fileIconName("Dockerfile")).toBe("file-config");
		expect(fileIconName("Makefile")).toBe("file-config");
		expect(fileIconName(".gitignore")).toBe("file-config");
		expect(fileIconName("pnpm-lock.yaml")).toBe("file-config");
		expect(fileIconName("package-lock.json")).toBe("file-config");
	});

	it("falls back to the generic file icon", () => {
		expect(fileIconName("notes")).toBe("file");
		expect(fileIconName("mystery.qqq")).toBe("file");
		expect(fileIconName("")).toBe("file");
	});
});

/** Issue #184: the tree row has its own, tighter height token. */
describe("the file tree row height", () => {
	it("uses the tree row density token", () => {
		const css = readFileSync(
			fileURLToPath(new URL("./files.css", `file://${__filename}`)),
			"utf8",
		);
		expect(css).toContain("height: var(--pk-tree-row);");
	});
});
