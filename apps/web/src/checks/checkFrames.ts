/**
 * Decoding what the control plane sends on a check output socket
 * (SPEC.md §18.1). Every frame is JSON text, and the output bytes inside it
 * are base64 so that escape sequences survive. Kept out of the React
 * component so it can be tested without a DOM.
 */
import { CheckOutputFrame } from "@portikus/contracts";
import { unparsedFrame } from "../frameFallback.js";

export type CheckFrame =
	| { kind: "output"; bytes: Uint8Array }
	| { kind: "exit"; exitCode: number }
	| { kind: "error"; code: string }
	| { kind: "ignored" };

/** base64 to bytes, with anything unreadable treated as empty. */
function decodeBase64(encoded: string): Uint8Array {
	try {
		const binary = atob(encoded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return new Uint8Array();
	}
}

export function decodeCheckFrame(data: unknown): CheckFrame {
	if (typeof data !== "string") return { kind: "ignored" };
	let message: unknown;
	try {
		message = JSON.parse(data);
	} catch {
		return { kind: "ignored" };
	}
	const parsed = CheckOutputFrame.safeParse(message);
	if (!parsed.success) {
		return unparsedFrame(message);
	}
	const frame = parsed.data;
	switch (frame.type) {
		case "output":
			return { kind: "output", bytes: decodeBase64(frame.data) };
		case "exit":
			return { kind: "exit", exitCode: frame.exitCode };
		case "error":
			return { kind: "error", code: frame.code };
	}
}
