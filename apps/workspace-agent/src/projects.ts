import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import {
	type AgentProject,
	CloneUrl,
	MAX_DOWNLOAD_BYTES,
	PROJECT_SLUG_PATTERN,
	projectNameFromRepository,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import { AgentFailure } from "./errors.js";
import { runGit, STDERR_LIMIT } from "./git.js";
import {
	excludePortikusFiles,
	PORTIKUS_IGNORE_LINES,
	writePortikusReadme,
} from "./project-files.js";

const run = promisify(execFile);

/** Clones run inside the request, so cap them. */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Copying a project tree runs inside the request too, with the same budget. */
const COPY_TIMEOUT_MS = CLONE_TIMEOUT_MS;

/** The prefix every half-finished clone directory carries. */
const TEMPORARY_PREFIX = ".tmp-";

export function projectsDir(homeDir: string): string {
	return join(homeDir, "projects");
}

export interface ResolvedProject {
	slug: string;
	path: string;
	exists: boolean;
}

/**
 * The single gate for every project path: the slug must match the pattern,
 * and an existing target must sit directly in the real `~/projects`, so a
 * symlink or a traversal cannot reach outside it (SPEC.md §24.6).
 */
export async function resolveProject(
	slug: string,
	homeDir: string,
): Promise<ResolvedProject> {
	if (!PROJECT_SLUG_PATTERN.test(slug)) {
		throw new AgentFailure("INVALID_SLUG", "invalid project slug");
	}
	const root = projectsDir(homeDir);
	await mkdir(root, { recursive: true });
	const realRoot = await realpath(root);
	const path = join(root, slug);
	let real: string;
	try {
		real = await realpath(path);
	} catch {
		return { slug, path: join(realRoot, slug), exists: false };
	}
	// The real path must be the directory named by the slug, sitting directly
	// in the real ~/projects. A slug that is a symlink to a sibling project
	// passes the parent check but fails on its name (SPEC.md §24.6).
	if (dirname(real) !== realRoot || basename(real) !== slug) {
		throw new AgentFailure(
			"INVALID_SLUG",
			"project path leaves the projects directory",
		);
	}
	return { slug, path: real, exists: true };
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isGitRepo(path: string): Promise<boolean> {
	return isDirectory(join(path, ".git"));
}

/**
 * The directory's own identity: its inode number as a decimal string.
 * `mv` within a filesystem keeps the inode, so this is what
 * lets the control plane recognise a project a student renamed in the shell.
 * A copy or a restore from an archive gets a new inode and is a new project,
 * which is the honest answer.
 */
async function directoryId(path: string): Promise<string | undefined> {
	try {
		return String((await stat(path)).ino);
	} catch {
		return undefined;
	}
}

/** Every directory directly under `~/projects` whose name is a valid slug. */
export async function listProjects(homeDir: string): Promise<AgentProject[]> {
	const root = projectsDir(homeDir);
	await mkdir(root, { recursive: true });
	const entries = await readdir(root, { withFileTypes: true });
	const projects: AgentProject[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!PROJECT_SLUG_PATTERN.test(entry.name)) continue;
		projects.push({
			slug: entry.name,
			isGitRepo: await isGitRepo(join(root, entry.name)),
			directoryId: await directoryId(join(root, entry.name)),
		});
	}
	projects.sort((a, b) => a.slug.localeCompare(b.slug));
	return projects;
}

/**
 * Remove half-finished clone directories left behind by a workspace that
 * stopped mid-clone. Called once at startup, when nothing else is running.
 */
export async function removeStaleTemporaries(homeDir: string): Promise<string[]> {
	const root = projectsDir(homeDir);
	await mkdir(root, { recursive: true });
	const removed: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(TEMPORARY_PREFIX)) continue;
		await rm(join(root, entry.name), { recursive: true, force: true });
		removed.push(entry.name);
	}
	return removed;
}

export async function getProject(slug: string, homeDir: string): Promise<AgentProject> {
	const target = await resolveProject(slug, homeDir);
	if (!target.exists || !(await isDirectory(target.path))) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	return {
		slug,
		isGitRepo: await isGitRepo(target.path),
		directoryId: await directoryId(target.path),
	};
}

/** Clone and init print little; past this the child is killed. */
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Run git through runGit, which never prompts for credentials (SPEC.md §24.6). */
async function git(args: string[], cwd: string, timeout?: number): Promise<void> {
	const result = await runGit(args, cwd, GIT_OUTPUT_LIMIT, timeout);
	if (result.ok) return;
	const reason = result.timedOut
		? "git timed out"
		: result.overflow
			? "git printed too much output"
			: `git exited with status ${result.exitCode}`;
	throw new AgentFailure("GIT_FAILED", result.stderr.slice(-STDERR_LIMIT) || reason);
}

/**
 * The .gitignore a project gets when Portikus initializes Git for it
 * (SPEC.md 7.2). It is written untracked; the platform never commits
 * (SPEC.md 12.5). Kept short and general so a student can edit it.
 */
const DEFAULT_GITIGNORE = `# Secrets and environment files
.env
.env.*
!.env.example
*.pem
*.key

# Node
node_modules/
dist/
build/
.next/
.cache/
*.log
npm-debug.log*
pnpm-debug.log*
.pnpm-store/

# Python
__pycache__/
*.py[cod]
.venv/
venv/
env/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.egg-info/
.ipynb_checkpoints/

# Databases and local data
*.sqlite
*.sqlite3
*.db
*.db-journal

# Editors and operating systems
.vscode/
.idea/
*.swp
.DS_Store
Thumbs.db

# Coverage and test output
coverage/
.nyc_output/
htmlcov/

# Local Docker overrides
docker-compose.override.yml

# Portikus working files; checks.json and README.md belong to the project
${PORTIKUS_IGNORE_LINES.join("\n")}
`;

/**
 * Write the default .gitignore, unless the project already has one. Then
 * the Portikus ignore lines go to .git/info/exclude instead, so the
 * project's own file is never edited.
 */
async function writeDefaultGitignore(path: string): Promise<void> {
	const file = join(path, ".gitignore");
	try {
		await access(file);
	} catch {
		await writeFile(file, DEFAULT_GITIGNORE);
		return;
	}
	await excludePortikusFiles(path);
}

/** Start a repository on main, never master. No commit is made. */
async function gitInit(path: string): Promise<void> {
	await git(["init", "--initial-branch=main"], path);
}

/** The largest file read to find a cloned repository's name. */
const NAME_FILE_LIMIT = 64 * 1024;

/** A regular file's text, or undefined; symlinks are never followed. */
async function readSmallFile(path: string): Promise<string | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > NAME_FILE_LIMIT) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The name a freshly cloned repository gives itself. */
async function suggestName(dir: string): Promise<string | undefined> {
	const readme = (await readdir(dir)).find((name) =>
		/^readme(\.(md|markdown))?$/i.test(name),
	);
	return projectNameFromRepository({
		readme: readme === undefined ? undefined : await readSmallFile(join(dir, readme)),
		packageJson: await readSmallFile(join(dir, "package.json")),
		pyproject: await readSmallFile(join(dir, "pyproject.toml")),
	});
}

export interface CreateProjectInput {
	slug: string;
	source: "new" | "clone" | "template";
	url?: string;
	gitInit: boolean;
}

/** Create a project directory (SPEC.md §7.2). Never makes a commit (§12.5). */
export async function createProject(
	input: CreateProjectInput,
	homeDir: string,
): Promise<AgentProject> {
	const target = await resolveProject(input.slug, homeDir);
	if (target.exists) {
		throw new AgentFailure("PROJECT_EXISTS", "a project with that name already exists");
	}
	const root = projectsDir(homeDir);

	if (input.source === "new") {
		await mkdir(target.path);
		if (input.gitInit) {
			await gitInit(target.path);
			await writeDefaultGitignore(target.path);
		}
		await writePortikusReadme(target.path);
		return { slug: input.slug, isGitRepo: input.gitInit };
	}

	// Defence in depth: the API validates the URL too.
	if (!input.url || !CloneUrl.safeParse(input.url).success) {
		throw new AgentFailure("INVALID_URL", "unsupported clone URL");
	}

	const temporary = join(root, `${TEMPORARY_PREFIX}${randomBytes(8).toString("hex")}`);
	let suggestedName: string | undefined;
	try {
		await git(["clone", "--", input.url, temporary], root, CLONE_TIMEOUT_MS);
		if (input.source === "template") {
			// A template becomes a fresh project with no upstream history.
			await rm(join(temporary, ".git"), { recursive: true, force: true });
			await gitInit(temporary);
			// A template that ships its own .gitignore keeps it.
			await writeDefaultGitignore(temporary);
			await writePortikusReadme(temporary);
		} else {
			// A clone's tracked files are the student's; only .git/info changes.
			await excludePortikusFiles(temporary);
			suggestedName = await suggestName(temporary);
		}
		await rename(temporary, target.path);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
	return {
		slug: input.slug,
		isGitRepo: true,
		...(suggestedName === undefined ? {} : { suggestedName }),
	};
}

/**
 * Remove a project directory for good (SPEC.md §7.3). A slug that is itself
 * a symlink has only the link removed, so the target is never followed and
 * never deleted; anything else must sit directly in the real `~/projects`
 * before it is removed (SPEC.md §24.6, §24.11).
 */
export async function deleteProject(slug: string, homeDir: string): Promise<void> {
	if (!PROJECT_SLUG_PATTERN.test(slug)) {
		throw new AgentFailure("INVALID_SLUG", "invalid project slug");
	}
	const root = projectsDir(homeDir);
	await mkdir(root, { recursive: true });
	const entry = join(root, slug);
	let link: boolean;
	try {
		link = (await lstat(entry)).isSymbolicLink();
	} catch {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	if (link) {
		await unlink(entry);
		return;
	}
	const target = await resolveProject(slug, homeDir);
	if (!target.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	await rm(target.path, { recursive: true, force: true });
}

export async function renameProject(
	slug: string,
	to: string,
	homeDir: string,
): Promise<AgentProject> {
	const source = await resolveProject(slug, homeDir);
	if (!source.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const target = await resolveProject(to, homeDir);
	if (target.exists) {
		throw new AgentFailure("PROJECT_EXISTS", "a project with that name already exists");
	}
	await rename(source.path, target.path);
	return { slug: to, isGitRepo: await isGitRepo(target.path) };
}

export async function duplicateProject(
	slug: string,
	to: string,
	homeDir: string,
): Promise<AgentProject> {
	const source = await resolveProject(slug, homeDir);
	if (!source.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const target = await resolveProject(to, homeDir);
	if (target.exists) {
		throw new AgentFailure("PROJECT_EXISTS", "a project with that name already exists");
	}
	try {
		// --no-dereference keeps symlinks as symlinks, so a link pointing
		// outside the project is copied, never followed (SPEC.md §24.6).
		await run("cp", ["-a", "--no-dereference", "--", source.path, target.path], {
			maxBuffer: 1024 * 1024,
			timeout: COPY_TIMEOUT_MS,
		});
	} catch (error) {
		await rm(target.path, { recursive: true, force: true });
		throw new AgentFailure(
			"GIT_FAILED",
			`could not duplicate the project: ${errorMessage(error)}`,
		);
	}
	return { slug: to, isGitRepo: await isGitRepo(target.path) };
}

/** Initialize Git on an existing project; a repository already there is a no-op. */
export async function gitInitProject(
	slug: string,
	homeDir: string,
): Promise<AgentProject> {
	const target = await resolveProject(slug, homeDir);
	if (!target.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	if (!(await isGitRepo(target.path))) {
		await gitInit(target.path);
		await writeDefaultGitignore(target.path);
	}
	return { slug, isGitRepo: true };
}

/**
 * Zip the project. `-y` stores symlinks rather than following them, so a
 * link out of the project cannot leak its target.
 */
export async function archiveProject(
	slug: string,
	homeDir: string,
	signal: AbortSignal,
): Promise<Readable> {
	const target = await resolveProject(slug, homeDir);
	if (!target.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	return archiveDir(target.path, signal);
}

/**
 * Zip one directory from its parent, so the archive holds a single top-level
 * entry named after that directory (SPEC.md §11.2). zip writes to a private
 * temporary file, because it cannot store a symlink entry on a pipe;
 * the returned stream deletes that file when it closes. Aborting `signal`
 * kills zip. The file goes under /var/tmp because /tmp is a tmpfs on
 * Debian 13, and a large zip there would count against the memory limit.
 */
export async function archiveDir(
	dir: string,
	signal: AbortSignal,
	tempBase = "/var/tmp",
): Promise<Readable> {
	await checkDownloadSize(dir);
	const tempDir = await mkdtemp(join(tempBase, "portikus-archive-"));
	const zipPath = join(tempDir, "archive.zip");
	try {
		await runZip(dir, zipPath, signal);
		const stream = createReadStream(zipPath);
		stream.once("close", () => {
			void rm(tempDir, { recursive: true, force: true });
		});
		return stream;
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Refuse a download over MAX_DOWNLOAD_BYTES before any zipping. A
 * directory counts the apparent size of its regular files, walked without
 * following symlinks, and the walk stops as soon as the cap is passed. A
 * symlink named directly counts its target file.
 */
export async function checkDownloadSize(path: string): Promise<void> {
	let total = 0;
	const pending = [path];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		try {
			let info = await lstat(current);
			// A symlinked file downloads its target's bytes, so count those.
			if (current === path && info.isSymbolicLink()) {
				const target = await stat(current);
				if (target.isFile()) info = target;
			}
			if (info.isFile()) {
				total += info.size;
				if (total > MAX_DOWNLOAD_BYTES) {
					throw new AgentFailure(
						"FILE_TOO_LARGE",
						"that download is over the size limit",
					);
				}
			} else if (info.isDirectory()) {
				for (const name of await readdir(current)) pending.push(join(current, name));
			}
		} catch (error) {
			// A file removed mid-walk, or one zip could not read either, adds nothing.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "EACCES") throw error;
		}
	}
}

function runZip(dir: string, zipPath: string, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn("zip", ["-r", "-y", "-q", zipPath, "--", basename(dir)], {
			cwd: dirname(dir),
			stdio: ["ignore", "ignore", "pipe"],
			signal,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
		});
		// An image without zip installed fails here, and an unhandled "error"
		// event would take the whole agent down.
		child.once("error", (error: Error) => {
			reject(new AgentFailure("INTERNAL", `could not start zip: ${error.message}`));
		});
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new AgentFailure("INTERNAL", `zip failed: ${stderr.trim()}`));
			}
		});
	});
}
