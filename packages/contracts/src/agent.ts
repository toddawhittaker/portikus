import { z } from "zod";
import { CloneUrl, ProjectSlug } from "./project.js";
import { TerminalTheme, Timezone } from "./settings.js";
import { CodingAgent, TerminalId } from "./terminal.js";

/**
 * Response body for `GET /health` on the workspace agent
 * (SPEC.md §26; STACK.md §10).
 */
export const AgentHealthResponse = z.object({
	ok: z.literal(true),
});
export type AgentHealthResponse = z.infer<typeof AgentHealthResponse>;

/**
 * A terminal as the agent knows it: the tmux session and how many browser
 * attachments it currently has (SPEC.md §9.5, §26).
 */
export const AgentTerminal = z.object({
	id: TerminalId,
	cwd: z.string().min(1),
	attachments: z.number().int().nonnegative(),
});
export type AgentTerminal = z.infer<typeof AgentTerminal>;

/** Response body for `GET /terminals` on the agent (SPEC.md §26). */
export const AgentTerminalList = z.object({
	terminals: z.array(AgentTerminal),
});
export type AgentTerminalList = z.infer<typeof AgentTerminalList>;

/**
 * Request body for `POST /terminals` on the agent (SPEC.md §9.3, §9.4).
 * The control plane mints the id, so the agent never invents one.
 */
export const AgentCreateTerminalRequest = z
	.object({
		id: TerminalId,
		cwd: z.string().min(1),
		/**
		 * The terminal's colour scheme (issue #267). The agent turns it into
		 * COLORFGBG in the shell's environment so a program that auto-detects,
		 * such as Claude Code, picks a matching theme.
		 */
		theme: TerminalTheme,
		/**
		 * The owner's timezone (issue #287). The agent sets TZ in the shell's
		 * environment, so a terminal opened after the setting changed reads the
		 * new zone without waiting for a workspace restart.
		 */
		timezone: Timezone,
		/**
		 * Present when a launcher is starting Claude or Codex (SPEC.md §10.2).
		 * There is no command string: the agent picks the CLI.
		 */
		agent: CodingAgent.optional(),
		/**
		 * Institution-provided keys for this process only (SPEC.md §10.6,
		 * §24.8). No other environment variable is accepted.
		 */
		institutionalEnv: z
			.object({
				ANTHROPIC_API_KEY: z.string().min(1).optional(),
				OPENAI_API_KEY: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type AgentCreateTerminalRequest = z.infer<typeof AgentCreateTerminalRequest>;

/**
 * Reply from `POST /terminals` on the agent (SPEC.md §10.9). Both ids are
 * null when the project had nothing to record. Any other field the agent
 * still sends is ignored by the caller, which reads only these two.
 */
export const AgentCreateTerminalResponse = z.object({
	baselineObjectId: z.string().nullable(),
	baselineHead: z.string().nullable(),
});
export type AgentCreateTerminalResponse = z.infer<typeof AgentCreateTerminalResponse>;

/**
 * A project directory as the agent sees it under `~/projects`
 * (SPEC.md §7.1; the agent owns the filesystem, STACK.md §10).
 */
export const AgentProject = z.object({
	slug: ProjectSlug,
	isGitRepo: z.boolean(),
	/**
	 * A stable identity for the directory itself: its inode number, as a
	 * decimal string. `mv` keeps it, so a project renamed in the shell can be
	 * reconnected to its old row rather than becoming a new one (issue #238).
	 * Optional because an older agent does not report it.
	 */
	directoryId: z.string().min(1).max(32).optional(),
});
export type AgentProject = z.infer<typeof AgentProject>;

/** Response body for `GET /projects` on the agent. */
export const AgentProjectList = z.object({
	projects: z.array(AgentProject),
});
export type AgentProjectList = z.infer<typeof AgentProjectList>;

/**
 * Request body for `POST /projects` on the agent (SPEC.md §7.2). The
 * control plane derives the slug, so the agent never invents one.
 */
export const AgentCreateProjectRequest = z
	.object({
		slug: ProjectSlug,
		source: z.enum(["new", "clone", "template"]),
		url: CloneUrl.optional(),
		gitInit: z.boolean(),
	})
	.strict();
export type AgentCreateProjectRequest = z.infer<typeof AgentCreateProjectRequest>;

/** Request body for `POST /projects/:slug/rename` (SPEC.md §7.3). */
export const AgentRenameProjectRequest = z
	.object({
		to: ProjectSlug,
	})
	.strict();
export type AgentRenameProjectRequest = z.infer<typeof AgentRenameProjectRequest>;

/** Request body for `POST /projects/:slug/duplicate` (SPEC.md §7.3). */
export const AgentDuplicateProjectRequest = z
	.object({
		to: ProjectSlug,
	})
	.strict();
export type AgentDuplicateProjectRequest = z.infer<typeof AgentDuplicateProjectRequest>;

/** Error codes returned by the workspace agent (SPEC.md §27; STACK.md §10). */
export const AgentErrorCode = z.enum([
	"BAD_REQUEST",
	"UNAUTHORIZED",
	"TERMINAL_NOT_FOUND",
	"TERMINAL_EXISTS",
	"TERMINAL_LIMIT",
	"ATTACHMENT_LIMIT",
	"INVALID_CWD",
	"TMUX_FAILED",
	"INTERNAL",
	"PROJECT_EXISTS",
	"PROJECT_NOT_FOUND",
	"INVALID_SLUG",
	"INVALID_URL",
	"GIT_FAILED",
	"PATH_INVALID",
	"FILE_NOT_FOUND",
	"FILE_EXISTS",
	"FILE_CHANGED",
	"FILE_TOO_LARGE",
	"NOT_A_DIRECTORY",
	"SEARCH_FAILED",
	"WATCH_FAILED",
	"EVENT_SOCKET_LIMIT",
	"CHECK_NOT_FOUND",
	"CHECK_RUNNING",
	"CHECK_NOT_RUNNING",
	"LISTENER_NOT_FOUND",
	"LISTENER_IS_SYSTEM",
	"STOP_FAILED",
	// Recovery points (SPEC.md §15, ADR 0020).
	"BUSY",
	"STORAGE_FULL",
	"RECOVERY_POINT_INVALID",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

/** Standard error response from the workspace agent (SPEC.md §27). */
export const AgentError = z.object({
	error: z.object({
		code: AgentErrorCode,
		message: z.string(),
	}),
});
export type AgentError = z.infer<typeof AgentError>;
