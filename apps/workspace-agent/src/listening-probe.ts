// Whether a listener speaks HTTPS, asked in plain HTTP first (BROWSER-HANDLING.md §17).
import { isIP, connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** The HTTP question gets most of the budget: a first compile can be slow. */
const HTTP_STEP_TIMEOUT_MS = 2000;

/** A TLS server answers plain HTTP at once, so the handshake step is short. */
const TLS_STEP_TIMEOUT_MS = 1000;

/** How long one probe may take, both steps together. */
const PROBE_TIMEOUT_MS = HTTP_STEP_TIMEOUT_MS + TLS_STEP_TIMEOUT_MS;

/** Bytes read while looking for the end of an HTTP status line. */
const STATUS_LINE_CAP = 128;

export type TlsProbe = (host: string, port: number) => Promise<boolean>;

/**
 * Whether a listener speaks HTTPS. It is asked in plain HTTP first, so a plain
 * HTTP server answers a normal request instead of logging a TLS handshake as
 * a garbled bad request; only a listener that does not answer in HTTP gets the
 * handshake. The HTTP step gets two thirds of the budget, the handshake one third.
 */
export async function probeTls(
	host: string,
	port: number,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const httpStep = (timeoutMs * HTTP_STEP_TIMEOUT_MS) / PROBE_TIMEOUT_MS;
	if (await answersHttp(host, port, httpStep)) return false;
	return completesTlsHandshake(host, port, timeoutMs - httpStep);
}

/**
 * Whether a listener answers a minimal HTTP request as a plain HTTP server.
 * A 400 is inconclusive: Go and nginx HTTPS servers send one to plain HTTP.
 */
function answersHttp(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let received = "";
		const socket = tcpConnect({ host, port });
		const finish = (http: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(http);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		const hostHeader = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
		socket.once("connect", () =>
			socket.write(`HEAD / HTTP/1.0\r\nHost: ${hostHeader}\r\n\r\n`),
		);
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("latin1");
			const end = received.indexOf("\r\n");
			if (end >= 0) {
				const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(received.slice(0, end));
				finish(status !== null && status[1] !== "400");
			} else if (
				received.length >= STATUS_LINE_CAP ||
				!"HTTP/".startsWith(received.slice(0, 5))
			) {
				finish(false);
			}
		});
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
	});
}

/**
 * Whether a listener completes a TLS handshake. Certificate checks are off
 * because a development server's certificate is self-signed; nothing is sent
 * after the handshake.
 */
function completesTlsHandshake(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = tlsConnect({
			host,
			port,
			rejectUnauthorized: false,
			// SNI may not be an IP address.
			...(isIP(host) === 0 ? { servername: host } : {}),
		});
		const finish = (https: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(https);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("secureConnect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
	});
}
