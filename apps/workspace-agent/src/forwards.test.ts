/**
 * Loopback forwards (BROWSER-HANDLING.md §11.1, §11.2) against real sockets:
 * a server on 127.0.0.1, a forward on a second loopback address, and proof
 * that bytes pass, that no other port is reachable, and that the forward
 * closes when its target goes away.
 */
import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { afterEach, expect, test } from "vitest";
import { ForwardFailure, Forwards } from "./forwards.js";
import type { ListeningMonitor } from "./listening.js";

/** A second loopback address, so the forward can reuse the target's port. */
const FORWARD_ADDRESS = "127.0.0.2";

const servers: Server[] = [];
const pools: Forwards[] = [];

afterEach(() => {
	for (const pool of pools) pool.closeEverything();
	pools.length = 0;
	for (const server of servers) server.close();
	servers.length = 0;
});

/** An echo server on one loopback address that prefixes what it is sent. */
async function echoServer(label: string, host = "127.0.0.1"): Promise<number> {
	const server = createServer((socket) => {
		socket.on("data", (chunk) => socket.write(`${label}:${chunk.toString()}`));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	return (server.address() as AddressInfo).port;
}

function roundTrip(host: string, port: number, message: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port }, () => socket.write(message));
		socket.on("data", (chunk) => {
			resolve(chunk.toString());
			socket.end();
		});
		socket.on("error", reject);
		socket.setTimeout(2000, () => {
			socket.destroy();
			reject(new Error("timed out"));
		});
	});
}

/**
 * A monitor stand-in: the tests drive which ports look loopback-only and
 * which loopback address each of them is listening on.
 */
function fakeMonitor(
	loopbackPorts: Set<number>,
	target: (port: number) => string | null = () => "127.0.0.1",
): ListeningMonitor {
	return {
		refresh: async () => [],
		isLoopbackOnly: (port: number) => loopbackPorts.has(port),
		hasLoopbackListener: (port: number) => loopbackPorts.has(port),
		loopbackTarget: (port: number) => (loopbackPorts.has(port) ? target(port) : null),
	} as unknown as ListeningMonitor;
}

function makeForwards(
	loopbackPorts: Set<number>,
	target?: (port: number) => string | null,
): Forwards {
	const pool = new Forwards({
		interfaceAddress: FORWARD_ADDRESS,
		monitor: fakeMonitor(loopbackPorts, target),
	});
	pools.push(pool);
	return pool;
}

test("a forward carries bytes to the loopback service and back", async () => {
	const port = await echoServer("one");
	const forwards = makeForwards(new Set([port]));

	const opened = await forwards.open(port);
	expect(opened).toEqual({ port, address: FORWARD_ADDRESS, state: "open" });
	expect(await roundTrip(FORWARD_ADDRESS, port, "hello")).toBe("one:hello");
	expect(forwards.list()).toEqual([{ port, address: FORWARD_ADDRESS, state: "open" }]);
	expect([...forwards.ports()]).toEqual([port]);
});

test("the forward reaches only its own port, not another one", async () => {
	const first = await echoServer("one");
	const second = await echoServer("two");
	const forwards = makeForwards(new Set([first, second]));
	await forwards.open(first);

	// Nothing is listening on the second port at the forward's address.
	await expect(roundTrip(FORWARD_ADDRESS, second, "hello")).rejects.toThrow();
	// And the second service is still reachable on loopback itself.
	expect(await roundTrip("127.0.0.1", second, "hello")).toBe("two:hello");
});

test("opening the same forward twice changes nothing", async () => {
	const port = await echoServer("one");
	const forwards = makeForwards(new Set([port]));
	await forwards.open(port);
	await forwards.open(port);
	expect(forwards.list()).toHaveLength(1);
	expect(await roundTrip(FORWARD_ADDRESS, port, "again")).toBe("one:again");
});

test("a port that is not listening on loopback is refused", async () => {
	const forwards = makeForwards(new Set());
	await expect(forwards.open(4321)).rejects.toMatchObject({
		code: "FORWARD_NOT_LOOPBACK",
		status: 409,
	});
});

test("a port already in use on the interface is refused", async () => {
	const port = await echoServer("one");
	// Something else already holds that port on the workspace interface.
	const blocker = createServer();
	servers.push(blocker);
	await new Promise<void>((resolve) => blocker.listen(port, FORWARD_ADDRESS, resolve));

	const forwards = makeForwards(new Set([port]));
	await expect(forwards.open(port)).rejects.toMatchObject({
		code: "FORWARD_PORT_IN_USE",
		status: 409,
	});
	expect(forwards.list()).toEqual([]);
});

test("a workspace with no interface address cannot forward", async () => {
	const forwards = new Forwards({
		interfaceAddress: null,
		monitor: fakeMonitor(new Set([1234])),
	});
	pools.push(forwards);
	await expect(forwards.open(1234)).rejects.toBeInstanceOf(ForwardFailure);
});

test("closing a forward stops it, and closing an unknown one says so", async () => {
	const port = await echoServer("one");
	const forwards = makeForwards(new Set([port]));
	await forwards.open(port);
	expect(forwards.close(port)).toBe(true);
	expect(forwards.close(port)).toBe(false);
	await expect(roundTrip(FORWARD_ADDRESS, port, "hello")).rejects.toThrow();
});

test("the forward closes itself when the loopback listener disappears", async () => {
	const port = await echoServer("one");
	const loopbackPorts = new Set([port]);
	const forwards = makeForwards(loopbackPorts);
	await forwards.open(port);

	loopbackPorts.delete(port);
	forwards.reconcile();

	expect(forwards.list()).toEqual([]);
	await expect(roundTrip(FORWARD_ADDRESS, port, "hello")).rejects.toThrow();
});

test("a forward reaches a service bound to ::1 only", async () => {
	const port = await echoServer("six", "::1");
	const forwards = makeForwards(new Set([port]), () => "::1");

	await forwards.open(port);
	expect(await roundTrip(FORWARD_ADDRESS, port, "hello")).toBe("six:hello");
});

test("the forward re-reads the loopback address on every connection", async () => {
	// The same port, first served over IPv4 and then over IPv6, as a restarted
	// development server can do.
	const port = await echoServer("four", "127.0.0.1");
	let host = "127.0.0.1";
	const forwards = makeForwards(new Set([port]), () => host);
	await forwards.open(port);
	expect(await roundTrip(FORWARD_ADDRESS, port, "hello")).toBe("four:hello");

	for (const server of servers.splice(0, servers.length)) server.close();
	const sixServer = createServer((socket) => {
		socket.on("data", (chunk) => socket.write(`six:${chunk.toString()}`));
	});
	servers.push(sixServer);
	await new Promise<void>((resolve) => sixServer.listen(port, "::1", resolve));
	host = "::1";

	expect(await roundTrip(FORWARD_ADDRESS, port, "hello")).toBe("six:hello");
});
