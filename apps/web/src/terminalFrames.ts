/**
 * Decoding what the control plane sends on a terminal WebSocket
 * (SPEC.md §9.7). Binary frames are raw PTY output; text frames are JSON.
 * Kept out of the React component so it can be tested without a DOM.
 */
export type TerminalFrame =
	| { kind: "output"; bytes: Uint8Array }
	| { kind: "exit" }
	| { kind: "error"; code: string }
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
	const { type, code } = message as { type?: unknown; code?: unknown };
	if (type === "exit") return { kind: "exit" };
	if (type === "error") {
		return { kind: "error", code: typeof code === "string" ? code : "unknown" };
	}
	return { kind: "ignored" };
}
