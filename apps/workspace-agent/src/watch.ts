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
const SKIPPED = new Set(GENERATED_NAMES.filter((name) => name !== ".git"));

/**
 * True for paths the watcher should not follow: anything inside a generated
 * directory, and inside `.git` everything below `objects`, so that changes to
 * `.git/index`, `.git/HEAD`, and `.git/refs` still arrive.
 */
export function isIgnored(root: string, path: string): boolean {
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
		const entry = await this.open(project.path);
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
	}

	private async open(root: string): Promise<Entry> {
		const existing = this.entries.get(root);
		if (existing) return existing;
		const pending = this.starting.get(root);
		if (pending) return pending;

		const started = (async () => {
			const watcher = watch(root, {
				ignoreInitial: true,
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
			watcher.on("all", (_event, path) => this.record(entry, path));
			watcher.on("error", (error) => this.fail(entry, error));
			await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
			this.entries.set(root, entry);
			return entry;
		})().finally(() => this.starting.delete(root));

		this.starting.set(root, started);
		return started;
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
		if (entry.failed) return;
		entry.failed = true;
		// Never log the paths themselves, only how many were pending.
		this.log.warn(
			{
				pending: entry.paths.size,
				error: error instanceof Error ? error.message : String(error),
			},
			"project watcher failed",
		);
		this.emit(entry, { type: "fs", paths: [], git: true, truncated: true });
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
		this.entries.delete(entry.root);
		void entry.watcher.close();
	}
}
