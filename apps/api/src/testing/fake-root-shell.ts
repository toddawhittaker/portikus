import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, encodeJsonFrame, FrameType } from "../root-shell/frames.js";

/**
 * A stand-in for the root-shell helper (packaging/root-shell, ADR 0051) for
 * the API tests and the browser tests. It speaks the same frames over a Unix
 * socket but runs no shell and needs no root: it prints a prompt, echoes
 * input back as output, reports each resize, and exits on the line `exit`.
 */

interface FakeRootShellConnection {
	/** The `open` frame's body. */
	open: Record<string, unknown> | null;
	/** Every frame type received after `open`, in order, by name. */
	frames: string[];
	/** The `end` frame's reason, if one came. */
	endReason: string | null;
	closed: boolean;
}

export interface FakeRootShell {
	socketPath: string;
	connections: FakeRootShellConnection[];
	close(): Promise<void>;
}

const NAMES: Record<number, string> = {
	[FrameType.OPEN]: "open",
	[FrameType.INPUT]: "input",
	[FrameType.RESIZE]: "resize",
	[FrameType.END]: "end",
};

export const FAKE_ROOT_PROMPT = "root@fake:~# ";

function serve(socket: Socket, record: FakeRootShellConnection): void {
	let buffered = Buffer.alloc(0);
	let line = "";
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= 5) {
			const type = buffered.readUInt8(0);
			const length = buffered.readUInt32BE(1);
			if (buffered.length < 5 + length) return;
			const body = buffered.subarray(5, 5 + length);
			buffered = buffered.subarray(5 + length);
			handle(type, body);
		}
	});
	socket.on("close", () => {
		record.closed = true;
	});
	socket.on("error", () => {});

	function handle(type: number, body: Buffer): void {
		const name = NAMES[type];
		if (!name || (record.open === null) !== (name === "open")) {
			socket.end(encodeJsonFrame(FrameType.ERROR, { code: "bad_frame" }));
			return;
		}
		if (name === "open") {
			record.open = JSON.parse(body.toString()) as Record<string, unknown>;
			socket.write(encodeFrame(FrameType.OUTPUT, FAKE_ROOT_PROMPT));
			return;
		}
		record.frames.push(name);
		if (name === "end") {
			record.endReason = (JSON.parse(body.toString()) as { reason: string }).reason;
			socket.end();
			return;
		}
		if (name === "resize") {
			const { cols, rows } = JSON.parse(body.toString()) as {
				cols: number;
				rows: number;
			};
			socket.write(encodeFrame(FrameType.OUTPUT, `[resized ${cols}x${rows}]\r\n`));
			return;
		}
		const text = body.toString();
		socket.write(encodeFrame(FrameType.OUTPUT, text.replace(/\r/g, "\r\n")));
		for (const ch of text) {
			if (ch !== "\r" && ch !== "\n") {
				line += ch;
				continue;
			}
			if (line.trim() === "exit") {
				socket.end(encodeJsonFrame(FrameType.EXIT, { status: 0 }));
				return;
			}
			line = "";
			socket.write(encodeFrame(FrameType.OUTPUT, FAKE_ROOT_PROMPT));
		}
	}
}

export async function startFakeRootShell(socketPath: string): Promise<FakeRootShell> {
	rmSync(socketPath, { force: true });
	const connections: FakeRootShellConnection[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const record: FakeRootShellConnection = {
			open: null,
			frames: [],
			endReason: null,
			closed: false,
		};
		connections.push(record);
		serve(socket, record);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	return {
		socketPath,
		connections,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
