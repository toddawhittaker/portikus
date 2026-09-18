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

/** How long changes are collected before a batch is sent (SPEC.md §25.1). */
export const FS_EVENT_BATCH_MS = 150;

/** The most paths one batch lists before it is truncated. */
export const MAX_FS_EVENT_PATHS = 200;

/** The most event sockets one agent serves at once (SPEC.md §11.4). */
export const MAX_EVENT_SOCKETS = 32;
