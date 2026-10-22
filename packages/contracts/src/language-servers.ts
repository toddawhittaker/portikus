import { z } from "zod";

/**
 * The language servers a workspace can run for code help. `ruff` serves only
 * Python formatting. Adding a server is one value here, one table entry in
 * the agent, and one line in the browser's server map.
 */
export const LANGUAGE_SERVER_IDS = ["python", "typescript", "ruff"] as const;
export const LanguageServerId = z.enum(LANGUAGE_SERVER_IDS);
export type LanguageServerId = z.infer<typeof LanguageServerId>;

/**
 * The languages an administrator can turn code help on for. A language is
 * listed here only when it ships (SPEC.md section 13.6, ADR 0067).
 */
export const CODE_HELP_LANGUAGE_IDS = ["python", "typescript"] as const;
export const CodeHelpLanguage = z.enum(CODE_HELP_LANGUAGE_IDS);
export type CodeHelpLanguage = z.infer<typeof CodeHelpLanguage>;

/** Total over every server, so a server added without a language does not compile. */
export const CODE_HELP_LANGUAGE_OF_SERVER: Record<LanguageServerId, CodeHelpLanguage> =
	{
		python: "python",
		ruff: "python",
		typescript: "typescript",
	};

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

/**
 * The only agent close reasons the control plane relays verbatim
 * (SPEC.md §13.6). Every other reason is replaced by a fixed
 * string of the API's own, so an agent cannot put its own text in front of a
 * student (SPEC.md §24.1).
 */
export const LANGUAGE_SERVER_CLOSE_REASONS = {
	crashed: "crashed",
	outOfMemory: "crashed: may have run out of memory",
} as const;
