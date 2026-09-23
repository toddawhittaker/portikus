import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_TIMEOUT_MS, AgentCallError, AgentClient } from "./agent-client.js";

/**
 * The agent lives inside the student's container, so the API must survive a
 * misbehaving one: an endless body and a connection that never answers
 * (SPEC.md §24.6, ADR 0009).
 */

let server: Server | undefined;

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

/**
 * Records the budget in milliseconds each call asks `AbortSignal.timeout` for.
 * That budget is a native timer which fake timers cannot move, so the tests
 * below check the number the client asked for and use fake timers only for the
 * upstream server's own delay.
 */
function recordBudgets(): number[] {
	const budgets: number[] = [];
	const real = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		budgets.push(ms);
		return real(ms);
	});
	return budgets;
}

async function startUpstream(
	handler: Parameters<typeof createServer>[1],
): Promise<number> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

test("createTerminal reads the baseline ids and refuses a bad one", async () => {
	const sha = "a".repeat(40);
	let body = "";
	const port = await startUpstream((request, response) => {
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id: "ignored",
					baselineObjectId: sha,
					baselineHead: null,
				}),
			);
		});
	});
	const client = new AgentClient("127.0.0.1", port, "token");
	await expect(
		client.createTerminal({
			id: "550e8400-e29b-41d4-a716-446655440000",
			cwd: "/home/student",
			theme: "dark",
			timezone: "America/New_York",
			agent: "codex",
		}),
	).resolves.toEqual({ baselineObjectId: sha, baselineHead: null });
	expect(JSON.parse(body).agent).toBe("codex");

	await new Promise<void>((resolve) => server?.close(() => resolve()));
	const badPort = await startUpstream((_request, response) => {
		response.writeHead(201, { "content-type": "application/json" });
		response.end(JSON.stringify({ baselineObjectId: 4, baselineHead: null }));
	});
	const bad = new AgentClient("127.0.0.1", badPort, "token");
	const error = await bad
		.createTerminal({
			id: "550e8400-e29b-41d4-a716-446655440000",
			cwd: "/home/student",
			theme: "dark",
			timezone: "America/New_York",
		})
		.catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
});

test("setLogLevel puts the level on /log-level behind the bearer token", async () => {
	const seen: { method?: string; url?: string; auth?: string; body: string } = {
		body: "",
	};
	const port = await startUpstream((request, response) => {
		seen.method = request.method;
		seen.url = request.url;
		seen.auth = request.headers.authorization;
		request.on("data", (chunk) => {
			seen.body += String(chunk);
		});
		request.on("end", () => {
			response.writeHead(204);
			response.end();
		});
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	await expect(client.setLogLevel("debug")).resolves.toBeUndefined();
	expect(seen.method).toBe("PUT");
	expect(seen.url).toBe("/log-level");
	expect(seen.auth).toBe("Bearer token");
	expect(JSON.parse(seen.body)).toEqual({ level: "debug" });
});

test("a JSON body past the cap is refused instead of buffered", async () => {
	const chunk = "x".repeat(64 * 1024);
	const port = await startUpstream((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		// Write forever; the client must stop reading well before this ends.
		const pump = () => {
			while (response.write(chunk)) {
				if (response.writableEnded) return;
			}
			response.once("drain", pump);
		};
		pump();
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	const error = await client.listProjects().catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
	expect((error as AgentCallError).message).toBe("agent response too large");
});

test("an error body past the cap on the download path is refused too", async () => {
	const chunk = "y".repeat(64 * 1024);
	const port = await startUpstream((_request, response) => {
		response.writeHead(500, { "content-type": "application/json" });
		const pump = () => {
			while (response.write(chunk)) {
				if (response.writableEnded) return;
			}
			response.once("drain", pump);
		};
		pump();
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	const error = await client.downloadProject("alpha").catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).message).toBe("agent response too large");
});

test("a download whose headers never arrive gives up", async () => {
	const port = await startUpstream(() => {
		// Never write a status line, so the client waits on headers.
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	// The header budget is an ordinary setTimeout, so fake timers can move it.
	vi.useFakeTimers();
	const pending = client.downloadProject("alpha").catch((caught) => caught);
	await vi.advanceTimersByTimeAsync(5000);
	vi.useRealTimers();
	const error = await pending;
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
}, 20_000);

test("duplicate gets the long budget, not the ordinary five seconds", async () => {
	const budgets = recordBudgets();
	let requestArrived: () => void = () => undefined;
	const arrived = new Promise<void>((resolve) => {
		requestArrived = resolve;
	});
	const port = await startUpstream((_request, response) => {
		// Longer than AGENT_TIMEOUT_MS, shorter than the clone-sized budget.
		setTimeout(() => {
			response.writeHead(204);
			response.end();
		}, 6000);
		requestArrived();
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	vi.useFakeTimers();
	const pending = client.duplicateProject("alpha", "beta");
	// Wait for the upstream handler to register its delay, then move it past
	// the ordinary budget instead of waiting six real seconds for it.
	await arrived;
	await vi.advanceTimersByTimeAsync(6000);
	vi.useRealTimers();
	await expect(pending).resolves.toBeUndefined();
	// It only survives a six-second reply because it asked for the
	// clone-sized budget rather than the ordinary five seconds.
	expect(budgets).toEqual([5 * 60 * 1000]);
}, 20_000);

test("an ordinary call still gives up after five seconds", async () => {
	const budgets = recordBudgets();
	const port = await startUpstream(() => {
		// Never answer.
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	// Left on real time: this budget is a native AbortSignal.timeout that fake
	// timers cannot move, and the five seconds are the point of the test.
	const error = await client.renameProject("alpha", "beta").catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
	expect(budgets).toEqual([AGENT_TIMEOUT_MS]);
}, 20_000);

test("a download that streams slowly after its headers is not cut off", async () => {
	const port = await startUpstream((_request, response) => {
		response.writeHead(200, { "content-type": "application/zip" });
		response.write("first");
		setTimeout(() => response.end("second"), 6000);
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	vi.useFakeTimers();
	const upstream = await client.downloadProject("alpha");
	// Far past the header budget: once bytes are flowing there is no cap.
	await vi.advanceTimersByTimeAsync(60_000);
	vi.useRealTimers();
	expect(await upstream.text()).toBe("firstsecond");
}, 20_000);

test("a caller cannot override the bearer token on fetchRaw", async () => {
	let seen: string | undefined;
	const port = await startUpstream((request, response) => {
		seen = request.headers.authorization;
		response.writeHead(204);
		response.end();
	});
	const client = new AgentClient("127.0.0.1", port, "real-token");

	await client.fetchRaw("GET", "/projects/lab/tree", {
		headers: { authorization: "Bearer stolen" },
	});
	expect(seen).toBe("Bearer real-token");
});

test("an agent that answers with a redirect is treated as unavailable", async () => {
	let followed = false;
	const port = await startUpstream((request, response) => {
		if (request.url === "/elsewhere") followed = true;
		response.writeHead(307, { location: "/elsewhere" });
		response.end();
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	for (const attempt of [
		client.listProjects(),
		client.fetchRaw("GET", "/projects/p/files"),
		client.downloadProject("p"),
	]) {
		const error = await attempt.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AgentCallError);
		expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
	}
	expect(followed).toBe(false);
});
