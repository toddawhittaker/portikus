import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	readdir,
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
import { type AgentProject, CloneUrl, PROJECT_SLUG_PATTERN } from "@portikus/contracts";
import { AgentFailure } from "./tmux.js";

const run = promisify(execFile);

/** Clones run inside the request, so cap them (plan: Epic 6 decisions). */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Copying a project tree runs inside the request too, with the same budget. */
const COPY_TIMEOUT_MS = CLONE_TIMEOUT_MS;

/** The prefix every half-finished clone directory carries. */
const TEMPORARY_PREFIX = ".tmp-";

/** How much git stderr travels back to the student. */
export const STDERR_LIMIT = 2048;

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
	return { slug, isGitRepo: await isGitRepo(target.path) };
}

function gitFailure(error: unknown): AgentFailure {
	const stderr =
		typeof (error as { stderr?: unknown }).stderr === "string"
			? (error as { stderr: string }).stderr
			: "";
	const tail = stderr.slice(-STDERR_LIMIT).trim();
	return new AgentFailure("GIT_FAILED", tail || String(error));
}

async function git(args: string[], cwd: string, timeout?: number): Promise<void> {
	try {
		await run("git", args, {
			cwd,
			timeout,
			// Git must never stop to ask a student for credentials.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch (error) {
		throw gitFailure(error);
	}
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
`;

/** Write the default .gitignore, unless the project already has one. */
async function writeDefaultGitignore(path: string): Promise<void> {
	const file = join(path, ".gitignore");
	try {
		await access(file);
		return;
	} catch {
		// No .gitignore yet, so the default is welcome.
	}
	await writeFile(file, DEFAULT_GITIGNORE);
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
			await git(["init"], target.path);
			await writeDefaultGitignore(target.path);
		}
		return { slug: input.slug, isGitRepo: input.gitInit };
	}

	// Defence in depth: the API validates the URL too.
	if (!input.url || !CloneUrl.safeParse(input.url).success) {
		throw new AgentFailure("INVALID_URL", "unsupported clone URL");
	}

	const temporary = join(root, `${TEMPORARY_PREFIX}${randomBytes(8).toString("hex")}`);
	try {
		await git(["clone", "--", input.url, temporary], root, CLONE_TIMEOUT_MS);
		if (input.source === "template") {
			// A template becomes a fresh project with no upstream history.
			await rm(join(temporary, ".git"), { recursive: true, force: true });
			await git(["init"], temporary);
			// A template that ships its own .gitignore keeps it.
			await writeDefaultGitignore(temporary);
		}
		await rename(temporary, target.path);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
	return { slug: input.slug, isGitRepo: true };
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
			`could not duplicate the project: ${error instanceof Error ? error.message : String(error)}`,
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
		await git(["init"], target.path);
		await writeDefaultGitignore(target.path);
	}
	return { slug, isGitRepo: true };
}

/**
 * Stream the project as a zip. `-y` stores symlinks rather than following
 * them, so a link out of the project cannot leak its target.
 */
export type ArchiveProcess = ChildProcessByStdio<null, Readable, Readable>;

export async function archiveProject(
	slug: string,
	homeDir: string,
): Promise<ArchiveProcess> {
	const target = await resolveProject(slug, homeDir);
	if (!target.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const child = spawn("zip", ["-r", "-y", "-q", "-", "--", slug], {
		cwd: projectsDir(homeDir),
		stdio: ["ignore", "pipe", "pipe"],
	});
	// An image without zip installed fails here, and an unhandled "error"
	// event would take the whole agent down.
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", (error: Error) => {
			reject(new AgentFailure("GIT_FAILED", `could not start zip: ${error.message}`));
		});
	});
	return child;
}
