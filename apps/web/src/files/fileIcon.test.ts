import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileIconName } from "./fileIcon.js";

/** SPEC.md §11.2: a file row says what kind of file it is. */
describe("the file row icon", () => {
	it("picks an icon from the extension for each family", () => {
		const families: [string, string][] = [
			["index.html", "file-web"],
			["styles.css", "file-style"],
			["theme.scss", "file-style"],
			["table.csv", "file-data"],
			["data.json", "file-data"],
			["compose.yaml", "file-data"],
			["README.md", "file-markdown"],
			["logo.png", "file-image"],
			["bundle.tar.gz", "file-archive"],
			["settings.ini", "file-config"],
			["report.pdf", "file-pdf"],
			["essay.docx", "file-text"],
			["essay.odt", "file-text"],
			["notes.txt", "file-text"],
			["letter.rtf", "file-text"],
			["grades.xlsx", "file-sheet"],
			["grades.ods", "file-sheet"],
			["lab.ipynb", "file-notebook"],
			["song.mp3", "file-audio"],
			["clip.mp4", "file-video"],
			["Inter.woff2", "file-font"],
			["Mono.ttf", "file-font"],
			["server.pem", "file-key"],
			["id.key", "file-key"],
		];
		for (const [name, icon] of families) expect(fileIconName(name), name).toBe(icon);
	});

	it("marks databases, compiled output, slides and logs", () => {
		const families: [string, string][] = [
			["app.db", "file-database"],
			["grades.sqlite", "file-database"],
			["grades.sqlite3", "file-database"],
			["sales.duckdb", "file-database"],
			["contacts.mdb", "file-database"],
			["Main.class", "file-binary"],
			["main.o", "file-binary"],
			["main.cpython-312.pyc", "file-binary"],
			["setup.exe", "file-binary"],
			["libgame.so", "file-binary"],
			["game.dll", "file-binary"],
			["module.wasm", "file-binary"],
			["a.out", "file-binary"],
			["talk.pptx", "file-slides"],
			["talk.odp", "file-slides"],
			["server.log", "file-log"],
		];
		for (const [name, icon] of families) expect(fileIconName(name), name).toBe(icon);
		// A database is data, not the script that builds it.
		expect(fileIconName("schema.sql")).toBe("file-sql");
		// Only the whole name a.out is a program; another .out file is not.
		expect(fileIconName("result.out")).toBe("file");
	});

	it("reuses the shell, key, config and lock icons for more names", () => {
		const reused: [string, string][] = [
			["build.bat", "file-shell"],
			["setup.ps1", "file-shell"],
			["server.crt", "file-key"],
			["server.cer", "file-key"],
			["id_rsa.pub", "file-key"],
			["id_rsa", "file-key"],
			["id_ed25519", "file-key"],
			[".dockerignore", "file-config"],
			[".npmrc", "file-config"],
			[".prettierrc", "file-config"],
			["requirements.txt", "file-lock"],
			["Requirements.TXT", "file-lock"],
		];
		for (const [name, icon] of reused) expect(fileIconName(name), name).toBe(icon);
		// Matched whole: other text files stay text.
		expect(fileIconName("requirements-notes.txt")).toBe("file-text");
	});

	it("tags each source language", () => {
		const languages: [string, string][] = [
			["main.py", "file-python"],
			["Main.java", "file-java"],
			["app.js", "file-javascript"],
			["app.mjs", "file-javascript"],
			["app.cjs", "file-javascript"],
			["App.jsx", "file-javascript"],
			["app.ts", "file-typescript"],
			["App.tsx", "file-typescript"],
			["main.c", "file-c"],
			["main.h", "file-c"],
			["main.cpp", "file-cpp"],
			["main.hpp", "file-cpp"],
			["schema.sql", "file-sql"],
			["run.sh", "file-shell"],
			["run.bash", "file-shell"],
			["run.zsh", "file-shell"],
			["main.go", "file-go"],
			["main.rs", "file-rust"],
			["Program.cs", "file-csharp"],
			["app.rb", "file-ruby"],
			["index.php", "file-php"],
			["Main.kt", "file-kotlin"],
			["App.swift", "file-swift"],
		];
		for (const [name, icon] of languages) expect(fileIconName(name), name).toBe(icon);
	});

	it("ignores case in names and extensions", () => {
		expect(fileIconName("MAIN.PY")).toBe("file-python");
		expect(fileIconName("Report.PDF")).toBe("file-pdf");
		expect(fileIconName("CARGO.LOCK")).toBe("file-lock");
		expect(fileIconName(".ENV")).toBe("file-key");
	});

	it("picks an icon from a well-known name", () => {
		expect(fileIconName("Dockerfile")).toBe("file-config");
		expect(fileIconName("Makefile")).toBe("file-config");
		expect(fileIconName(".gitignore")).toBe("file-config");
		expect(fileIconName("LICENSE")).toBe("file-markdown");
	});

	it("knows lock files by their exact name", () => {
		for (const name of [
			"package-lock.json",
			"pnpm-lock.yaml",
			"yarn.lock",
			"poetry.lock",
			"Cargo.lock",
		]) {
			expect(fileIconName(name), name).toBe("file-lock");
		}
		// A name that only contains "lock" is still data.
		expect(fileIconName("clock.json")).toBe("file-data");
		expect(fileIconName("lockfile.yaml")).toBe("file-data");
	});

	it("marks environment files by their .env prefix", () => {
		for (const name of [".env", ".env.local", ".env.production", "app.env"]) {
			expect(fileIconName(name), name).toBe("file-key");
		}
		// Only the dotted prefix counts, not a name that starts with env.
		expect(fileIconName(".envrc")).toBe("file");
		expect(fileIconName("environment.yml")).toBe("file-data");
	});

	it("falls back to the generic file icon", () => {
		expect(fileIconName("notes")).toBe("file");
		expect(fileIconName("mystery.qqq")).toBe("file");
		expect(fileIconName("")).toBe("file");
	});
});

/** The tree row has its own, tighter height token. */
describe("the file tree row height", () => {
	it("uses the tree row density token", () => {
		const css = readFileSync(
			fileURLToPath(new URL("./files.css", `file://${__filename}`)),
			"utf8",
		);
		expect(css).toContain("height: var(--pk-tree-row);");
	});
});
