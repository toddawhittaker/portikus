/**
 * The files Portikus puts in a project it creates (SPEC.md §7.2, §18.1):
 * the ignore lines for `.portikus/` working files and the
 * `.portikus/README.md` that explains checks. None of this is ever
 * committed (SPEC.md §12.5).
 */
import { constants } from "node:fs";
import {
	appendFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { HANDOFF_NOTES_DIR } from "@portikus/contracts";

/** Everything under `.portikus/` is working data except these two files. */
export const PORTIKUS_IGNORE_LINES = [
	".portikus/*",
	"!.portikus/checks.json",
	"!.portikus/README.md",
];

/** The README a new project gets under `.portikus/`. */
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
 * repository's own `.gitignore` is left alone. Adding them twice is
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
 * lines the first time Portikus writes under `.portikus/`. A project
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
const PASTE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.(png|jpeg)$/;
/** The folders the web client makes for dropped files (apps/web terminalDrop). */
const DROP_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/;
export const PASTES_DIR = ".portikus/pastes";
const PASTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Delete the regular files in a drop folder older than the cap, then the folder if it is empty and old. */
async function removeOldDrops(folder: string, now: number): Promise<void> {
	const folderOld = now - (await lstat(folder)).mtimeMs > PASTE_MAX_AGE_MS;
	for (const name of await readdir(folder)) {
		const file = join(folder, name);
		const info = await lstat(file);
		if (info.isFile() && now - info.mtimeMs > PASTE_MAX_AGE_MS) {
			await rm(file);
		}
	}
	// A folder changed within the cap may be mid-drop, so only old ones go.
	if (!folderOld) return;
	try {
		await rmdir(folder);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
	}
}

/**
 * Delete pastes in `<project>/.portikus/pastes` last modified more than 7
 * days before `now`: pasted images, and the files inside the dated folders
 * that dropped files go to. Only regular files with those names go; a
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
		const path = join(pastes, name);
		if (PASTE_NAME.test(name)) {
			const info = await lstat(path);
			if (info.isFile() && now - info.mtimeMs > PASTE_MAX_AGE_MS) {
				await rm(path);
			}
		} else if (DROP_FOLDER.test(name) && (await lstat(path)).isDirectory()) {
			await removeOldDrops(path, now);
		}
	}
}

/** A real directory at `path`, made if missing; a symlink or a file there refuses the write. */
async function realDirectory(path: string): Promise<void> {
	try {
		if (!(await lstat(path)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path);
	}
}

/** `2026-11-14T10-20-30Z`: the UTC second, with no colons for other systems' file names. */
function noteStamp(now: Date): string {
	return now
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replaceAll(":", "-");
}

/**
 * Save a handoff note as `.portikus/handoffs/<UTC time>.md` and return its
 * project-relative path (SPEC.md §10.8). Never replaces a file, and never
 * follows a symlinked `.portikus` or `handoffs` out of the project. The
 * ignore lines go in first, so the note is never offered to Git.
 */
export async function writeHandoffNote(
	projectPath: string,
	markdown: string,
	now = new Date(),
): Promise<string> {
	await realDirectory(join(projectPath, ".portikus"));
	await realDirectory(join(projectPath, HANDOFF_NOTES_DIR));
	await excludeOnPortikusWrite(projectPath, HANDOFF_NOTES_DIR);
	const stamp = noteStamp(now);
	for (let attempt = 0; ; attempt += 1) {
		const name = attempt === 0 ? `${stamp}.md` : `${stamp}-${attempt}.md`;
		const relPath = `${HANDOFF_NOTES_DIR}/${name}`;
		try {
			await writeFile(join(projectPath, relPath), markdown, { flag: "wx" });
			return relPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 99)
				throw error;
		}
	}
}

/**
 * The absolute path of a handoff note, refusing any path that is absolute,
 * climbs with `..`, or lands outside `<project>/.portikus/handoffs/`, since
 * a recorded path could have been planted (SPEC.md §24).
 */
function handoffNoteFile(projectPath: string, relPath: string): string {
	if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
		throw new Error("not a handoff note path");
	}
	const dir = resolve(projectPath, HANDOFF_NOTES_DIR);
	const file = resolve(projectPath, relPath);
	if (!file.startsWith(`${dir}${sep}`)) throw new Error("not a handoff note path");
	return file;
}

/** `.portikus` and `handoffs` are real directories, not symlinks out of the project. */
async function realNotesDir(projectPath: string): Promise<void> {
	for (const dir of [".portikus", HANDOFF_NOTES_DIR]) {
		if (!(await lstat(join(projectPath, dir))).isDirectory()) {
			throw new Error("not a directory");
		}
	}
}

/** Read a saved handoff note, never through a symlink or outside the notes directory. */
export async function readHandoffNote(
	projectPath: string,
	relPath: string,
): Promise<string> {
	const path = handoffNoteFile(projectPath, relPath);
	await realNotesDir(projectPath);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

/** Replace a saved handoff note's text, never through a symlink or outside the notes directory. */
export async function rewriteHandoffNote(
	projectPath: string,
	relPath: string,
	markdown: string,
): Promise<void> {
	await realDirectory(join(projectPath, ".portikus"));
	await realDirectory(join(projectPath, HANDOFF_NOTES_DIR));
	const file = await open(
		handoffNoteFile(projectPath, relPath),
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
		0o644,
	);
	try {
		await file.writeFile(markdown);
	} finally {
		await file.close();
	}
}
