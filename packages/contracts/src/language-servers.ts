import { z } from "zod";

/**
 * The language servers a workspace can run for code help. `ruff` serves only
 * Python formatting. Adding a server is one value here, one table entry in
 * the agent, and one line in the browser's server map.
 */
export const LANGUAGE_SERVER_IDS = ["python", "typescript", "ruff"] as const;
export const LanguageServerId = z.enum(LANGUAGE_SERVER_IDS);
export type LanguageServerId = z.infer<typeof LanguageServerId>;

/** Largest server-to-browser message the agent forwards; a bigger one becomes a JSON-RPC error. */
export const LANGUAGE_SERVER_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Largest document the browser sends to a language server. */
export const LANGUAGE_SERVER_MAX_DOCUMENT_BYTES = 512 * 1024;

/** The most language-server sockets one workspace may have open through the control plane. */
export const MAX_LANGUAGE_SERVER_SOCKETS = 4;

/**
 * The most servers one workspace runs at once. Only `python` and
 * `typescript` count; `ruff` does not.
 */
export const MAX_LANGUAGE_SERVERS_PER_WORKSPACE = 3;
