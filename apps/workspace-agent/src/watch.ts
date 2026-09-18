import { relative, sep } from "node:path";
import {
	FS_EVENT_BATCH_MS,
	type FsEvent,
	GENERATED_NAMES,
	MAX_FS_EVENT_PATHS,
} from "@portikus/contracts";
import { type FSWatcher, watch } from "chokidar";
import type { FastifyBaseLogger } from "fastify";
import { resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";

export type FsListener = (event: FsEvent) => void;

/** Names skipped outright; `.git` is handled separately (SPEC.md §11.4). */
const SKIPPED: ReadonlySet<string> = new Set<string>(
	GENERATED_NAMES.filter((name) => name !== ".git"),
);

/** How long a watcher may take to become ready before we give up. */
const READY_TIMEOUT_MS = 10_000;

/**
 * True for paths the watcher should not follow: anything inside a generated
 * directory, and inside `.git` everything below `objects`, so that changes to
 * `.git/index`, `.git/HEAD`, and `.git/refs` still arrive.
 */
function isIgnored(root: string, path: string): boolean {
	const rel = relative(root, path);
	if (rel === "" || rel.startsWith("..")) return false;
	const segments = rel.split(sep);
	for (const [index, segment] of segments.entries()) {
		if (SKIPPED.has(segment)) return true;
		// Git rewrites objects constantly and none of it changes the tree.
		if (segment === ".git" && segments[index + 1] === "objects") return true;
	}
	return false;
}

/** The errno code of a filesystem error, safe to log: it holds no path. */
function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "UNKNOWN";
}

interface Entry {
	watcher: FSWatcher;
	root: string;
	listeners: Set<FsListener>;
	paths: Set<string>;
	git: boolean;
	truncated: boolean;
	timer: NodeJS.Timeout | null;
	failed: boolean;
}

/**
 * One chokidar watcher per project root, shared by every subscriber, with
 * changes batched into FsEvent frames (SPEC.md §11.4, §25.1).
 */
export class ProjectWatchers {
	private readonly entries = new Map<string, Entry>();
	private readonly starting = new Map<string, Promise<Entry>>();

	constructor(private readonly log: FastifyBaseLogger) {}

	/** How many project watchers are open. For tests and diagnostics. */
	size(): number {
		return this.entries.size;
	}

	/**
	 * Watch a project and receive batched change frames. Resolves once the
	 * watcher is ready, and returns the function that stops listening.
	 */
	async subscribe(
		homeDir: string,
		slug: string,
		listener: FsListener,
	): Promise<() => void> {
		const project = await resolveProject(slug, homeDir);
		if (!project.exists) {
			throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
		}
		let entry = await this.open(project.path);
		// The watcher may have failed and been dropped while we waited, so a
		// late subscriber must not attach to one nobody is watching any more.
		if (this.entries.get(project.path) !== entry) {
			entry = await this.open(project.path);
		}
		entry.listeners.add(listener);
		return () => {
			if (!entry.listeners.delete(listener)) return;
			if (entry.listeners.size === 0) this.close(entry);
		};
	}

	/** Close every watcher, for shutdown. */
	closeEverything(): void {
		for (const entry of [...this.entries.values()]) {
			entry.listeners.clear();
			this.close(entry);
		}
		// A watcher still starting would otherwise outlive the routes.
		for (const pending of [...this.starting.values()]) {
			void pending.then(
				(entry) => {
					entry.listeners.clear();
					this.close(entry);
				},
				() => {},
			);
		}
	}

	private async open(root: string): Promise<Entry> {
		const existing = this.entries.get(root);
		if (existing) return existing;
		const pending = this.starting.get(root);
		if (pending) return pending;

		const started = this.start(root).finally(() => this.starting.delete(root));
		this.starting.set(root, started);
		return started;
	}

	private async start(root: string): Promise<Entry> {
		const watcher = watch(root, {
			ignoreInitial: true,
			followSymlinks: false,
			ignored: (path: string) => isIgnored(root, path),
		});
		const entry: Entry = {
			watcher,
			root,
			listeners: new Set(),
			paths: new Set(),
			git: false,
			truncated: false,
			timer: null,
			failed: false,
		};
		try {
			// Chokidar never emits `ready` when the first scan fails, so wait on
			// all three outcomes rather than only the happy one.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("watcher did not become ready")),
					READY_TIMEOUT_MS,
				);
				// A start that is still waiting must not hold the process open.
				timer.unref();
				watcher.once("ready", () => {
					clearTimeout(timer);
					resolve();
				});
				watcher.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
		} catch (error) {
			this.log.warn({ code: errnoCode(error) }, "project watcher failed to start");
			this.log.debug(
				{ error: error instanceof Error ? error.message : String(error) },
				"project watcher start error",
			);
			await watcher.close().catch(() => {});
			throw new AgentFailure("WATCH_FAILED", "could not watch project");
		}
		watcher.on("all", (_event, path) => this.record(entry, path));
		watcher.on("error", (error) => this.fail(entry, error));
		this.entries.set(root, entry);
		return entry;
	}

	private record(entry: Entry, path: string): void {
		const rel = relative(entry.root, path);
		if (rel === "" || rel.startsWith("..")) return;
		if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
			// The client refetches Git status, so the path itself adds nothing.
			entry.git = true;
		} else if (entry.paths.size >= MAX_FS_EVENT_PATHS) {
			entry.truncated = true;
		} else {
			entry.paths.add(rel);
		}
		if (entry.timer === null) {
			entry.timer = setTimeout(() => this.flush(entry), FS_EVENT_BATCH_MS);
			// A pending batch must not hold the process open at shutdown.
			entry.timer.unref();
		}
	}

	private flush(entry: Entry): void {
		entry.timer = null;
		const event: FsEvent = {
			type: "fs",
			paths: [...entry.paths],
			git: entry.git,
			truncated: entry.truncated,
		};
		entry.paths.clear();
		entry.git = false;
		entry.truncated = false;
		if (event.paths.length === 0 && !event.git && !event.truncated) return;
		this.emit(entry, event);
	}

	private fail(entry: Entry, error: unknown): void {
		if (!entry.failed) {
			entry.failed = true;
			// Never log the paths themselves, only how many were pending, and
			// never the message, which carries the path (SPEC.md §24.6).
			this.log.warn(
				{ pending: entry.paths.size, code: errnoCode(error) },
				"project watcher failed",
			);
			this.log.debug(
				{ error: error instanceof Error ? error.message : String(error) },
				"project watcher error",
			);
			this.emit(entry, { type: "fs", paths: [], git: true, truncated: true });
		}
		// Drop the broken watcher so the next subscriber builds a fresh one.
		entry.listeners.clear();
		this.close(entry);
	}

	private emit(entry: Entry, event: FsEvent): void {
		for (const listener of [...entry.listeners]) {
			try {
				listener(event);
			} catch {
				// A broken listener must not stop the others.
			}
		}
	}

	private close(entry: Entry): void {
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
		if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root);
		entry.watcher
			.close()
			.catch((error) =>
				this.log.warn({ code: errnoCode(error) }, "watcher close failed"),
			);
	}
}
