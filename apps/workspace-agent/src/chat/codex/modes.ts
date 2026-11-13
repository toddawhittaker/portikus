import type { ChatModeInfo } from "@portikus/contracts";

/**
 * Codex's permission modes in the picker's five places, in Codex's own
 * words (SPEC.md §10.8). Each is an approval policy with a sandbox; Plan
 * also plans first. The container is the trust boundary (SPEC.md §24.2),
 * and Codex's own sandbox works inside it, so Auto uses the workspace
 * sandbox as the terminal Codex does.
 */
export const CODEX_MODES: ChatModeInfo[] = [
	{
		id: "untrusted",
		label: "Ask",
		description: "Codex asks before running any command that could change something.",
		warning: false,
		plan: false,
	},
	{
		id: "readOnly",
		label: "Read only",
		description: "Codex can read and answer, and asks before it changes anything.",
		warning: false,
		plan: false,
	},
	{
		id: "plan",
		label: "Plan",
		description: "Codex looks around and writes a plan before it changes anything.",
		warning: false,
		plan: true,
	},
	{
		id: "onRequest",
		label: "Auto",
		description:
			"Codex works in the project on its own and asks before going outside it.",
		warning: false,
		plan: false,
	},
	{
		id: "fullAccess",
		label: "Full access",
		description: "Codex runs anything without asking and without a sandbox.",
		warning: true,
		plan: false,
	},
];

export type CodexModeId =
	| "untrusted"
	| "readOnly"
	| "plan"
	| "onRequest"
	| "fullAccess";

/** What a chat starts at: Codex's own default. */
export const CODEX_START_MODE: CodexModeId = "onRequest";

export function isCodexMode(id: string): id is CodexModeId {
	return CODEX_MODES.some((mode) => mode.id === id);
}

export type SandboxPolicy =
	| { type: "readOnly"; networkAccess: boolean }
	| { type: "dangerFullAccess" }
	| {
			type: "workspaceWrite";
			writableRoots: string[];
			networkAccess: boolean;
			excludeTmpdirEnvVar: boolean;
			excludeSlashTmp: boolean;
	  };

/** Codex's own workspace sandbox, before a thread says what the student configured. */
export const DEFAULT_WORKSPACE_SANDBOX: SandboxPolicy = {
	type: "workspaceWrite",
	writableRoots: [],
	networkAccess: false,
	excludeTmpdirEnvVar: false,
	excludeSlashTmp: false,
};

export interface ModePolicy {
	approvalPolicy: "untrusted" | "on-request" | "never";
	/** The sandbox as `thread/start` names it. */
	sandbox: "read-only" | "workspace-write" | "danger-full-access";
	/** The sandbox as `turn/start` takes it. */
	sandboxPolicy: SandboxPolicy;
}

/** The approval policy and sandbox one mode means, with the workspace sandbox in force. */
export function modePolicy(mode: CodexModeId, workspace: SandboxPolicy): ModePolicy {
	switch (mode) {
		case "untrusted":
			return {
				approvalPolicy: "untrusted",
				sandbox: "workspace-write",
				sandboxPolicy: workspace,
			};
		case "readOnly":
			return {
				approvalPolicy: "on-request",
				sandbox: "read-only",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			};
		case "fullAccess":
			return {
				approvalPolicy: "never",
				sandbox: "danger-full-access",
				sandboxPolicy: { type: "dangerFullAccess" },
			};
		default:
			return {
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
				sandboxPolicy: workspace,
			};
	}
}
