import { relative, sep } from "node:path";
import {
	FS_EVENT_BATCH_MS,
	type FsEvent,
	MAX_FS_EVENT_PATHS,
	MAX_WATCHED_DIRS,
	WATCH_SKIP_NAMES,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import { type FSWatcher, watch } from "chokidar";
import type { FastifyBaseLogger } from "fastify";
import { AgentFailure } from "./errors.js";
import { resolveProject } from "./projects.js";

/**
 * A subscriber. `null` means the watcher has failed and will send nothing
 * more, so the caller must tell its own client (SPEC.md §11.4).
 */
export type FsListener = (event: FsEvent | null) => void;

/** Names skipped outright; `.git` is handled separately (SPEC.md §11.4). */
const SKIPPED: ReadonlySet<string> = new Set<string>(
	WATCH_SKIP_NAMES.filter((name) => name !== ".git"),
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

/**
 * For the hidden-files watcher: everything except the top-level generated
 * folders themselves and what is inside them. The main watcher already
 * covers the rest, so this one adds only those folders.
 */
function isOutsideGenerated(root: string, path: string): boolean {
	const rel = relative(root, path);
	if (rel === "" || rel.startsWith("..")) return false;
	const first = rel.split(sep)[0] ?? "";
	return !SKIPPED.has(first);
}

/**
 * The project has more folders than one watcher follows. The watcher is
 * already closed; the caller sends `watch_limited` once (SPEC.md §11.4).
 */
export class WatchLimitedError extends Error {
	constructor() {
		super("project too large to watch");
		this.name = "WatchLimitedError";
	}
}

/** The errno code of a filesystem error, safe to log: it holds no path. */
function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "UNKNOWN";
}

interface Entry {
	watcher: FSWatcher;
	/** The map key: the root, or the root with HIDDEN_KEY for the hidden-files watcher. */
	key: string;
	root: string;
	listeners: Set<FsListener>;
	paths: Set<string>;
	git: boolean;
	truncated: boolean;
	timer: NodeJS.Timeout | null;
	failed: boolean;
}

/** Marks the hidden-files watcher's key apart from the main one for the same root. */
const HIDDEN_KEY = "\0hidden";

/**
 * One chokidar watcher per project root, shared by every subscriber, with
 * changes batched into FsEvent frames (SPEC.md §11.4, §25.1).
 *
 * A subscriber that shows hidden files also shares a second, narrow watcher
 * per root. It follows only the top-level generated folders (node_modules,
 * dist, .venv and the rest of WATCH_SKIP_NAMES) and the entries directly
 * inside them, which is what an expanded generated folder shows. Its cost is
 * one inotify watch for the root plus one per such folder, a handful in
 * practice. A folder inside a generated folder, or one nested deeper in the
 * project, is not followed and still waits for the next refetch. It runs
 * only while some subscriber asks for hidden files.
 */
export class ProjectWatchers {
	private readonly entries = new Map<string, Entry>();
	private readonly starting = new Map<string, Promise<Entry>>();

	constructor(
		private readonly log: FastifyBaseLogger,
		/** Overrides the folder cap. For tests. */
		private readonly maxDirs: number = MAX_WATCHED_DIRS,
		/** Overrides how long a start may take. For tests. */
		private readonly readyTimeoutMs: number = READY_TIMEOUT_MS,
	) {}

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
		options: { hidden?: boolean } = {},
	): Promise<() => void> {
		const project = await resolveProject(slug, homeDir);
		if (!project.exists) {
			throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
		}
		const attached = [await this.attach(project.path, false, listener)];
		if (options.hidden) {
			// Best effort: without it the tree still updates, only not inside
			// generated folders, which is how it behaves with hidden files off.
			try {
				attached.push(await this.attach(project.path, true, listener));
			} catch (error) {
				this.log.info(
					{ code: error instanceof AgentFailure ? error.code : "WATCH_LIMITED" },
					"hidden-files watcher not started",
				);
			}
		}
		return () => {
			for (const entry of attached) {
				if (!entry.listeners.delete(listener)) continue;
				if (entry.listeners.size === 0) this.close(entry);
			}
		};
	}

	private async attach(root: string, hidden: boolean, listener: FsListener) {
		const key = hidden ? `${root}${HIDDEN_KEY}` : root;
		let entry = await this.open(key, root, hidden);
		// The watcher may have failed and been dropped while we waited, so a
		// late subscriber must not attach to one nobody is watching any more.
		if (this.entries.get(key) !== entry) {
			entry = await this.open(key, root, hidden);
		}
		entry.listeners.add(listener);
		return entry;
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

	private async open(key: string, root: string, hidden: boolean): Promise<Entry> {
		const existing = this.entries.get(key);
		if (existing) return existing;
		const pending = this.starting.get(key);
		if (pending) return pending;

		const started = this.start(key, root, hidden).finally(() =>
			this.starting.delete(key),
		);
		this.starting.set(key, started);
		return started;
	}

	private async start(key: string, root: string, hidden: boolean): Promise<Entry> {
		// The first scan's events are wanted only to count folders against the
		// cap; nothing is recorded until the watcher is ready.
		const watcher = watch(
			root,
			hidden
				? {
						ignoreInitial: false,
						followSymlinks: false,
						// The root's entries, then the entries of each generated folder.
						depth: 1,
						ignored: (path: string) => isOutsideGenerated(root, path),
					}
				: {
						ignoreInitial: false,
						followSymlinks: false,
						ignored: (path: string) => isIgnored(root, path),
					},
		);
		const entry: Entry = {
			watcher,
			key,
			root,
			listeners: new Set(),
			paths: new Set(),
			git: false,
			truncated: false,
			timer: null,
			failed: false,
		};
		let dirs = 0;
		try {
			// Chokidar never emits `ready` when the first scan fails, so wait on
			// all three outcomes rather than only the happy one.
			await new Promise<void>((resolve, reject) => {
				// A scan this slow is a project too big to watch, not a fault.
				const timer = setTimeout(
					() => reject(new WatchLimitedError()),
					this.readyTimeoutMs,
				);
				// A start that is still waiting must not hold the process open.
				timer.unref();
				const countDir = () => {
					dirs += 1;
					if (dirs > this.maxDirs) {
						clearTimeout(timer);
						reject(new WatchLimitedError());
					}
				};
				watcher.on("addDir", countDir);
				watcher.once("ready", () => {
					clearTimeout(timer);
					watcher.off("addDir", countDir);
					resolve();
				});
				watcher.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
		} catch (error) {
			if (error instanceof WatchLimitedError) {
				this.log.info({ maxDirs: this.maxDirs }, "project too large to watch");
				await watcher.close().catch(() => {});
				throw error;
			}
			this.log.warn({ code: errnoCode(error) }, "project watcher failed to start");
			this.log.debug({ error: errorMessage(error) }, "project watcher start error");
			await watcher.close().catch(() => {});
			throw new AgentFailure("WATCH_FAILED", "could not watch project");
		}
		watcher.on("all", (_event, path) => this.record(entry, path));
		watcher.on("error", (error) => this.fail(entry, error));
		this.entries.set(key, entry);
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
			this.log.debug({ error: errorMessage(error) }, "project watcher error");
			// Subscribers hear the failure itself, not a last catch-all frame:
			// this watcher is going away and they have to reconnect.
			this.emit(entry, null);
		}
		// Drop the broken watcher so the next subscriber builds a fresh one.
		entry.listeners.clear();
		this.close(entry);
	}

	/**
	 * Push one frame that is not a filesystem batch, on the sockets already
	 * watching this project root (BROWSER-HANDLING.md §18).
	 */
	publish(root: string, message: object): boolean {
		const entry = this.entries.get(root);
		if (!entry || entry.failed || entry.listeners.size === 0) return false;
		this.emit(entry, message as FsEvent);
		return true;
	}

	private emit(entry: Entry, event: FsEvent | null): void {
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
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		entry.watcher
			.close()
			.catch((error) =>
				this.log.warn({ code: errnoCode(error) }, "watcher close failed"),
			);
	}
}
