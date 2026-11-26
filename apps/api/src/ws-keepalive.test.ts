import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { keepAlive, PING_INTERVAL_MS } from "./ws-keepalive.js";

class FakeSocket extends EventEmitter {
	ping = vi.fn();
	terminate = vi.fn();
}

describe("keepAlive", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function start(): FakeSocket {
		const socket = new FakeSocket();
		keepAlive(socket as unknown as WebSocket);
		return socket;
	}

	it("pings every 30 seconds, well under Cloudflare's 100-second idle close", () => {
		expect(PING_INTERVAL_MS).toBe(30_000);
		const socket = start();
		vi.advanceTimersByTime(29_999);
		expect(socket.ping).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(socket.ping).toHaveBeenCalledTimes(1);
	});

	it("keeps a socket that answers each ping", () => {
		const socket = start();
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(PING_INTERVAL_MS);
			socket.emit("pong");
		}
		expect(socket.ping).toHaveBeenCalledTimes(10);
		expect(socket.terminate).not.toHaveBeenCalled();
	});

	it("ends a socket after two pings in a row go unanswered", () => {
		const socket = start();
		vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
		expect(socket.terminate).not.toHaveBeenCalled();
		vi.advanceTimersByTime(PING_INTERVAL_MS);
		expect(socket.terminate).toHaveBeenCalledTimes(1);
		expect(socket.ping).toHaveBeenCalledTimes(2);
	});

	it("forgives one missed pong when the next one arrives", () => {
		const socket = start();
		vi.advanceTimersByTime(PING_INTERVAL_MS); // missed
		vi.advanceTimersByTime(PING_INTERVAL_MS);
		socket.emit("pong");
		vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
		expect(socket.terminate).not.toHaveBeenCalled();
	});

	it("stops its timer when the socket closes", () => {
		const socket = start();
		socket.emit("close");
		vi.advanceTimersByTime(PING_INTERVAL_MS * 5);
		expect(socket.ping).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
