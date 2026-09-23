// HTTP and WebSocket helpers for the load driver. Every request goes to the
// VM's own Caddy on loopback, whatever the host name says, so a preview host
// that DNS would send elsewhere still reaches this VM.
import https from "node:https";

const agent = new https.Agent({ keepAlive: true, maxSockets: 256 });

/** Latency samples and failures, by operation name. */
export class Metrics {
	constructor() {
		this.samples = new Map();
		this.failures = new Map();
		this.errors = [];
	}
	record(name, ms) {
		if (!this.samples.has(name)) this.samples.set(name, []);
		this.samples.get(name).push(ms);
	}
	fail(name, why) {
		this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
		if (this.errors.length < 200)
			this.errors.push(`${new Date().toISOString()} ${name}: ${why}`);
	}
	failed(name) {
		return this.failures.get(name) ?? 0;
	}
	summary(name) {
		const list = [...(this.samples.get(name) ?? [])].sort((a, b) => a - b);
		const at = (p) =>
			list.length
				? list[Math.min(list.length - 1, Math.ceil((p / 100) * list.length) - 1)]
				: null;
		return {
			count: list.length,
			failed: this.failed(name),
			p50: at(50),
			p95: at(95),
			p99: at(99),
			max: list.length ? list[list.length - 1] : null,
		};
	}
	names() {
		return [...new Set([...this.samples.keys(), ...this.failures.keys()])].sort();
	}
}

/**
 * request(url, {method, headers, body, timeoutMs}) resolves to
 * {status, headers, body, ms}; a network error or timeout rejects.
 */
export function request(
	url,
	{ method = "GET", headers = {}, body, timeoutMs = 30000 } = {},
) {
	const target = new URL(url);
	const started = performance.now();
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: "127.0.0.1",
				port: target.port || 443,
				servername: target.hostname,
				path: target.pathname + target.search,
				method,
				agent,
				headers: { host: target.host, ...headers },
				timeout: timeoutMs,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
						ms: performance.now() - started,
					}),
				);
				res.on("error", reject);
			},
		);
		req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** Opens a WebSocket and resolves once it is open. */
export function openSocket(url, headers) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers });
		ws.binaryType = "arraybuffer";
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("socket did not open in 30 s"));
		}, 30000);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			reject(new Error(`socket error ${event.message ?? ""}`));
		});
	});
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when check() returns a truthy value, polling; rejects at the deadline. */
export async function waitFor(what, check, { everyMs = 250, timeoutMs = 60000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
		await sleep(everyMs);
	}
}
