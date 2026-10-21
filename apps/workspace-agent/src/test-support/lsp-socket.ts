/** A test client for the language-server socket: JSON-RPC in, frames collected. */
import { expect, vi } from "vitest";

export interface LspSocket {
	ws: WebSocket;
	frames: Array<Record<string, unknown>>;
	closed: Promise<{ code: number; reason: string }>;
	send: (message: unknown) => void;
	/** The response to request `id`, waiting for it. */
	response: (id: number | string, timeout?: number) => Promise<Record<string, unknown>>;
	/** The first frame matching, waiting for it. */
	frame: (
		match: (frame: Record<string, unknown>) => boolean,
		timeout?: number,
	) => Promise<Record<string, unknown>>;
}

export async function openLspSocket(url: string, token?: string): Promise<LspSocket> {
	const ws = new WebSocket(url, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	} as unknown as string[]);
	const frames: Array<Record<string, unknown>> = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(event.data as string) as Record<string, unknown>);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener(
			"close",
			(event) => resolve({ code: event.code, reason: event.reason }),
			{
				once: true,
			},
		);
	});
	await new Promise<void>((resolve) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("close", () => resolve(), { once: true });
	});
	const frame = async (
		match: (frame: Record<string, unknown>) => boolean,
		timeout = 5000,
	): Promise<Record<string, unknown>> => {
		let found: Record<string, unknown> | undefined;
		await vi.waitFor(
			() => {
				found = frames.find(match);
				expect(found).toBeDefined();
			},
			{ timeout, interval: 20 },
		);
		return found as Record<string, unknown>;
	};
	return {
		ws,
		frames,
		closed,
		send: (message) => ws.send(JSON.stringify(message)),
		frame,
		response: (id, timeout) =>
			frame((one) => one.id === id && one.method === undefined, timeout),
	};
}

/** A minimal `initialize` request, as the browser would send it. */
export function initializeRequest(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			processId: 99999,
			rootUri: "file:///somewhere/else",
			rootPath: "/somewhere/else",
			workspaceFolders: [{ uri: "file:///somewhere/else", name: "else" }],
			capabilities: {},
			...extra,
		},
	};
}
