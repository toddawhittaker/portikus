import { createConnection, type Socket } from "node:net";

/** How long the helper's socket may take to accept a connection. */
const CONNECT_TIMEOUT_MS = 5000;

/** Connect to the root-shell helper's Unix socket (ADR 0051). */
export function connectRootShellHelper(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("root shell helper did not answer"));
		}, CONNECT_TIMEOUT_MS);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
