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
	const { type, code, path, alternate, reason, at } = message as {
		type?: unknown;
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
		? "Your workspace ran out of memory and its terminals were restarted."
		: "Your workspace's terminals were restarted.";
}

// Restarts already told to the student, so panes lost together toast once.
const toldRestarts = new Set<string>();

/** True the first time this page hears of one restart. */
export function firstNoticeOf(at: string): boolean {
	if (toldRestarts.has(at)) return false;
	toldRestarts.add(at);
	return true;
}
