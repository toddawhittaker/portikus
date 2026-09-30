/**
 * Decoding what the control plane sends on a terminal WebSocket
 * (SPEC.md §9.7). Binary frames are raw PTY output; text frames are JSON.
 * Kept out of the React component so it can be tested without a DOM.
 */
/** Why a terminal's session is gone, when the control plane knows (SPEC.md §9.7). */
export type TerminalGoneReason = "out_of_memory" | "restarted";

export type TerminalFrame =
	| { kind: "output"; bytes: Uint8Array }
	| { kind: "exit" }
	| { kind: "cwd"; path: string }
	| { kind: "screen"; alternate: boolean }
	| { kind: "clear" }
	| { kind: "agent"; build: string }
	| { kind: "error"; code: string; reason?: TerminalGoneReason; at?: string }
	| { kind: "ignored" };

export function decodeTerminalFrame(data: unknown): TerminalFrame {
	if (data instanceof ArrayBuffer) {
		return { kind: "output", bytes: new Uint8Array(data) };
	}
	if (typeof data !== "string") return { kind: "ignored" };
	let message: unknown;
	try {
		message = JSON.parse(data);
	} catch {
		return { kind: "ignored" };
	}
	if (typeof message !== "object" || message === null) return { kind: "ignored" };
	const { type, code, path, alternate, reason, at, build } = message as {
		type?: unknown;
		build?: unknown;
		code?: unknown;
		reason?: unknown;
		at?: unknown;
		path?: unknown;
		alternate?: unknown;
	};
	if (type === "exit") return { kind: "exit" };
	if (type === "cwd" && typeof path === "string" && path !== "") {
		return { kind: "cwd", path };
	}
	if (type === "screen" && typeof alternate === "boolean") {
		return { kind: "screen", alternate };
	}
	if (type === "clear") return { kind: "clear" };
	if (type === "agent" && typeof build === "string" && build !== "") {
		return { kind: "agent", build };
	}
	if (type === "error") {
		const frame: TerminalFrame = {
			kind: "error",
			code: typeof code === "string" ? code : "unknown",
		};
		if (reason === "out_of_memory" || reason === "restarted") {
			frame.reason = reason;
			frame.at = typeof at === "string" ? at : "";
		}
		return frame;
	}
	return { kind: "ignored" };
}

/** The toast for terminals lost to a terminals unit restart (SPEC.md §9.7). */
export function terminalGoneMessage(reason: TerminalGoneReason): string {
	return reason === "out_of_memory"
		? "Your workspace ran out of memory, so its terminals were closed."
		: "Your workspace's terminals were closed.";
}

/** What the student can do about it, the toast's body. */
export const TERMINAL_GONE_NEXT_STEP = "Open a new terminal to carry on.";

// Restarts already told to the student, so panes lost together toast once.
const toldRestarts = new Set<string>();

/** True the first time this page hears of one restart. */
export function firstNoticeOf(at: string): boolean {
	if (toldRestarts.has(at)) return false;
	toldRestarts.add(at);
	return true;
}

/** The toast for an agent upgraded and restarted under an open page (issue #887). */
export const AGENT_UPGRADED_MESSAGE =
	"Portikus was updated. Your terminals are still running.";

// Per workspace: the agent build this page first saw, and the builds already told.
const firstBuilds = new Map<string, string>();
const toldBuilds = new Set<string>();

/**
 * True the first time this page hears of a workspace's agent running a build
 * other than the one it first saw, so panes reconnecting together toast once.
 */
export function upgradedAgentNotice(workspaceId: string, build: string): boolean {
	const first = firstBuilds.get(workspaceId);
	if (first === undefined) {
		firstBuilds.set(workspaceId, build);
		return false;
	}
	const key = `${workspaceId} ${build}`;
	if (build === first || toldBuilds.has(key)) return false;
	toldBuilds.add(key);
	return true;
}

/** Forget a workspace's agent build once its terminals are gone, so a fresh start is not called an upgrade. */
export function forgetAgentBuild(workspaceId: string): void {
	firstBuilds.delete(workspaceId);
	for (const key of toldBuilds) {
		if (key.startsWith(`${workspaceId} `)) toldBuilds.delete(key);
	}
}
