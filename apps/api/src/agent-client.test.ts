import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { AgentCallError, AgentClient } from "./agent-client.js";

/**
 * The agent lives inside the student's container, so the API must survive a
 * misbehaving one: an endless body and a connection that never answers
 * (SPEC.md §24.6, ADR 0009).
 */

let server: Server | undefined;

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

async function startUpstream(
	handler: Parameters<typeof createServer>[1],
): Promise<number> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

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

	const started = Date.now();
	const error = await client.downloadProject("alpha").catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
	expect(Date.now() - started).toBeLessThan(15_000);
}, 20_000);

test("duplicate gets the long budget, not the ordinary five seconds", async () => {
	const port = await startUpstream((_request, response) => {
		// Longer than AGENT_TIMEOUT_MS, shorter than the clone-sized budget.
		setTimeout(() => {
			response.writeHead(204);
			response.end();
		}, 6000);
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	await expect(client.duplicateProject("alpha", "beta")).resolves.toBeUndefined();
}, 20_000);

test("an ordinary call still gives up after five seconds", async () => {
	const port = await startUpstream(() => {
		// Never answer.
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	const error = await client.renameProject("alpha", "beta").catch((caught) => caught);
	expect(error).toBeInstanceOf(AgentCallError);
	expect((error as AgentCallError).code).toBe("AGENT_UNAVAILABLE");
}, 20_000);

test("a download that streams slowly after its headers is not cut off", async () => {
	const port = await startUpstream((_request, response) => {
		response.writeHead(200, { "content-type": "application/zip" });
		response.write("first");
		setTimeout(() => response.end("second"), 6000);
	});
	const client = new AgentClient("127.0.0.1", port, "token");

	const upstream = await client.downloadProject("alpha");
	expect(await upstream.text()).toBe("firstsecond");
}, 20_000);
