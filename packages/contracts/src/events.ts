import { z } from "zod";

/**
 * A batch of filesystem changes inside one project, pushed over the agent's
 * events WebSocket (SPEC.md §11.4, STACK.md §5). Paths are project-relative.
 * `git` means something under `.git/` changed, so the client refetches Git
 * status. `truncated` means too many paths changed to list, so the client
 * refetches the whole tree.
 */
export const FsEvent = z.object({
	type: z.literal("fs"),
	paths: z.array(z.string()),
	git: z.boolean(),
	truncated: z.boolean(),
});
export type FsEvent = z.infer<typeof FsEvent>;

/**
 * Sent once when a project has more folders than the watcher follows. The
 * watcher is closed; the browser stops reconnecting and refreshes on focus
 * instead (SPEC.md §11.4).
 */
export const WatchLimited = z.object({ type: z.literal("watch_limited") });
export type WatchLimited = z.infer<typeof WatchLimited>;

/** The most folders one project watcher follows (SPEC.md §11.4). */
export const MAX_WATCHED_DIRS = 20_000;

/** How long changes are collected before a batch is sent (SPEC.md §25.1). */
export const FS_EVENT_BATCH_MS = 150;

/** The most paths one batch lists before it is truncated. */
export const MAX_FS_EVENT_PATHS = 200;

/** The most event sockets one agent serves at once (SPEC.md §11.4). */
export const MAX_EVENT_SOCKETS = 32;

/**
 * The most event sockets one workspace may have open through the control
 * plane at once (SPEC.md §11.4, §24.1). The agent has its own, larger cap;
 * this one keeps a single workspace from using all of it.
 */
export const MAX_EVENT_SOCKETS_PER_WORKSPACE = 8;
