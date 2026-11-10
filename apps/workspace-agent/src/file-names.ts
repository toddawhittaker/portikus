import { type ChildProcess, spawn } from "node:child_process";
import {
	type FileNameSearchResponse,
	MAX_FILE_NAME_MATCHES,
	ProjectPath,
} from "@portikus/contracts";
import { AgentFailure } from "./errors.js";
import { resolveInProject } from "./files.js";

/** How long one file-name search may run before it answers with what it has. */
const FILE_NAME_SEARCH_TIMEOUT_MS = 3000;

/** How many file paths one search reads from ripgrep before it stops. */
const MAX_FILES_SCANNED = 200_000;

/** How many matches are kept for ranking; the best of them are returned. */
const MAX_CANDIDATES = 5000;

/**
 * How many ripgrep processes may run at once. The menu searches as the
 * student types, and a cancelled request kills its process, so only several
 * windows typing together reach this.
 */
export const MAX_RUNNING_FILE_NAME_SEARCHES = 4;
let runningSearches = 0;

export interface FileNameSearchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxScanned?: number;
	/** Test seam: receives the ripgrep child as soon as it is spawned. */
	onChild?: (child: ChildProcess) => void;
}

/**
 * The ripgrep flags that list a project's files. `.gitignore` applies even
 * without a Git repository, parent folders' ignore files do not, hidden
 * files stay out, and a symlink is neither followed nor listed (SPEC.md
 * §24.6). `--null` keeps a newline in a file name from splitting a path.
 */
const RG_ARGS = [
	"--files",
	"--null",
	"--no-follow",
	"--no-require-git",
	"--no-ignore-parent",
	"--no-config",
];

/**
 * How well a path matches a lower-cased query, lower is better, or null for
 * no match: the exact file name, its prefix, inside the file name, inside
 * the path, then the query's letters in order with gaps.
 */
function matchRank(path: string, query: string): number | null {
	if (query === "") return 0;
	const lower = path.toLowerCase();
	const name = lower.slice(lower.lastIndexOf("/") + 1);
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	if (lower.includes(query)) return 3;
	let at = 0;
	for (const char of query) {
		at = lower.indexOf(char, at) + 1;
		if (at === 0) return null;
	}
	return 4;
}

interface Candidate {
	path: string;
	rank: number;
	depth: number;
}

function byRelevance(a: Candidate, b: Candidate): number {
	return (
		a.rank - b.rank ||
		a.depth - b.depth ||
		a.path.length - b.path.length ||
		(a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	);
}

/**
 * Find project files by name for the chat composer's `@` menu. The query only
 * filters the list ripgrep prints for the project root; it is never joined to
 * a path, so nothing outside the project can be reached. Neither the query nor
 * any path is logged (STACK.md §15).
 */
export async function searchFileNames(
	homeDir: string,
	slug: string,
	query: string,
	limit: number,
	options: FileNameSearchOptions = {},
): Promise<FileNameSearchResponse> {
	// The same gate every file route uses, so the root is the same folder.
	const root = await resolveInProject(homeDir, slug, "", { mustExist: true });
	if (options.signal?.aborted) return { paths: [], truncated: false };
	if (runningSearches >= MAX_RUNNING_FILE_NAME_SEARCHES) {
		throw new AgentFailure("BUSY", "too many searches are running");
	}

	const wanted = Math.min(limit, MAX_FILE_NAME_MATCHES);
	const maxScanned = options.maxScanned ?? MAX_FILES_SCANNED;
	const lowered = query.toLowerCase();
	const child = spawn("rg", RG_ARGS, {
		cwd: root.path,
		stdio: ["ignore", "pipe", "pipe"],
		// An rg config file could otherwise inject flags such as --pre.
		env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
	});
	runningSearches += 1;
	options.onChild?.(child);

	const candidates: Candidate[] = [];
	let matched = 0;
	let scanned = 0;
	let truncated = false;
	let stopped = false;
	const stop = () => {
		if (!stopped) {
			stopped = true;
			child.kill("SIGKILL");
		}
	};

	const consume = (path: string) => {
		scanned += 1;
		if (scanned > maxScanned) {
			truncated = true;
			stop();
			return;
		}
		if (!ProjectPath.safeParse(path).success) return;
		const rank = matchRank(path, lowered);
		if (rank === null) return;
		matched += 1;
		if (candidates.length < MAX_CANDIDATES) {
			candidates.push({ path, rank, depth: path.split("/").length });
		} else {
			truncated = true;
		}
	};

	const timer = setTimeout(() => {
		truncated = true;
		stop();
	}, options.timeoutMs ?? FILE_NAME_SEARCH_TIMEOUT_MS);
	const onAbort = () => stop();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (stopped) return;
		const parts = (pending + chunk).split("\0");
		pending = parts.pop() ?? "";
		for (const part of parts) {
			if (stopped) return;
			if (part !== "") consume(part);
		}
	});
	// Drained so a noisy run cannot stall ripgrep; the text is not kept.
	child.stderr.resume();

	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", () => {
				reject(new AgentFailure("INTERNAL", "could not list files"));
			});
			child.once("close", resolve);
		});
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		runningSearches -= 1;
	}
	if (options.signal?.aborted) return { paths: [], truncated: false };
	if (!stopped && pending !== "") consume(pending);

	candidates.sort(byRelevance);
	return {
		paths: candidates.slice(0, wanted).map((candidate) => candidate.path),
		truncated: truncated || matched > wanted,
	};
}
