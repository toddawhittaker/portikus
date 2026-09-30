/**
 * The files Portikus puts in a project it creates (SPEC.md §7.2, §18.1):
 * the ignore lines for `.portikus/` working files and the
 * `.portikus/README.md` that explains checks. None of this is ever
 * committed (SPEC.md §12.5).
 */
import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** Everything under `.portikus/` is working data except these two files (#856). */
export const PORTIKUS_IGNORE_LINES = [
	".portikus/*",
	"!.portikus/checks.json",
	"!.portikus/README.md",
];

/** The README a new project gets under `.portikus/` (#857). */
export const PORTIKUS_README = `# Portikus project files

Portikus keeps a few files for this project in this folder. Two of them
belong to the project and are saved in Git: this README and \`checks.json\`.
Everything else here (pasted images, for example) is working data that Git
ignores.

## Checks

A check is an ordinary command that tells you whether the project works,
such as running its tests or its linter. Portikus lists your checks in the
Checks pane, runs them in this project folder, and shows their output as
it happens. A check passes when its command exits with code 0 and fails
otherwise.

Checks live in \`checks.json\`:

\`\`\`json
{
  "checks": [
    { "id": "test", "name": "Tests", "command": "npm test" },
    { "id": "lint", "name": "Lint", "command": "npm run lint" }
  ]
}
\`\`\`

- \`id\` is a short name: lowercase letters, digits and dashes.
- \`name\` is what the Checks pane shows, up to 80 characters.
- \`command\` is run by the shell in this folder, exactly as if you typed it.
- No other fields are allowed.

Examples for other languages:

| Project | Command |
|---|---|
| Python tests | \`pytest\` |
| Python lint | \`ruff check .\` |
| Java with Maven | \`mvn -q test\` |
| Java with Gradle | \`./gradlew test\` |
| Anything with a Makefile | \`make test\` |

You can also add or edit checks from the Checks pane.

## For coding agents

When you add tests, a linter, a type checker or a build step to this
project, add or update a check in \`checks.json\` so the student can rerun
it. Keep each check to one command that exits non-zero on failure. Do not
add a check that always passes. Do not remove a student's checks without
saying so.
`;

/**
 * Add the ignore lines to `.git/info/exclude`, which Git never tracks, so a
 * repository's own `.gitignore` is left alone (#856). Adding them twice is
 * avoided by looking for the first line.
 */
export async function excludePortikusFiles(projectPath: string): Promise<void> {
	const info = join(projectPath, ".git", "info");
	const file = join(info, "exclude");
	await mkdir(info, { recursive: true });
	let current = "";
	try {
		current = await readFile(file, "utf8");
	} catch {
		// No exclude file yet.
	}
	if (current.split("\n").includes(PORTIKUS_IGNORE_LINES[0] as string)) return;
	const gap = current === "" || current.endsWith("\n") ? "" : "\n";
	await appendFile(file, `${gap}${PORTIKUS_IGNORE_LINES.join("\n")}\n`);
}

/**
 * Called after a write at `relPath`: an older Git project gets the exclude
 * lines the first time Portikus writes under `.portikus/` (#856). A project
 * without a `.git` directory is left alone.
 */
export async function excludeOnPortikusWrite(
	projectPath: string,
	relPath: string,
): Promise<void> {
	if (relPath !== ".portikus" && !relPath.startsWith(".portikus/")) return;
	try {
		if (!(await lstat(join(projectPath, ".git"))).isDirectory()) return;
	} catch {
		return;
	}
	await excludePortikusFiles(projectPath);
}

/**
 * Write `.portikus/README.md` unless something is already there. A
 * `.portikus` that is not a real directory (a symlink from a template, say)
 * is left alone, so the write can never land outside the project.
 */
export async function writePortikusReadme(projectPath: string): Promise<void> {
	const dir = join(projectPath, ".portikus");
	try {
		if (!(await lstat(dir)).isDirectory()) return;
	} catch {
		await mkdir(dir);
	}
	try {
		// "wx" fails on anything already at the path, a symlink included.
		await writeFile(join(dir, "README.md"), PORTIKUS_README, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** The names the web client gives pasted images (apps/web TerminalPane pastePath). */
export const PASTE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.(png|jpeg)$/;
export const PASTES_DIR = ".portikus/pastes";
export const PASTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete pastes in `<project>/.portikus/pastes` last modified more than 7
 * days before `now` (#885). Only regular files with a paste name go; a
 * symlinked folder or file is never followed.
 */
export async function removeOldPastes(
	projectPath: string,
	now = Date.now(),
): Promise<void> {
	const portikus = join(projectPath, ".portikus");
	const pastes = join(projectPath, PASTES_DIR);
	for (const dir of [portikus, pastes]) {
		if (!(await lstat(dir)).isDirectory()) return;
	}
	for (const name of await readdir(pastes)) {
		if (!PASTE_NAME.test(name)) continue;
		const file = join(pastes, name);
		const info = await lstat(file);
		if (info.isFile() && now - info.mtimeMs > PASTE_MAX_AGE_MS) {
			await rm(file);
		}
	}
}
