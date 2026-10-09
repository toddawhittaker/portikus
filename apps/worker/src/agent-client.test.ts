import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchDockerInventory, HttpRecoveryAgent } from "./agent-client.js";

let handler: http.RequestListener = () => {};
let server: http.Server;
let port: number;

beforeEach(async () => {
	server = http.createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

const REQ = { projectId: crypto.randomUUID(), pointId: crypto.randomUUID() };

function agent(timeouts = { create: 5000, delete: 5000 }): HttpRecoveryAgent {
	return new HttpRecoveryAgent("127.0.0.1", port, "t".repeat(64), timeouts);
}

test("a reply over 1 MiB is refused, not buffered", async () => {
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(`"${"x".repeat(2 * 1024 * 1024)}"`);
	};
	await expect(agent().createRecoveryPoint("p", REQ)).rejects.toMatchObject({
		code: "AGENT_UNAVAILABLE",
		message: "agent response too large",
	});
});

test("a redirect is not followed", async () => {
	let followed = false;
	handler = (req, res) => {
		if (req.url === "/elsewhere") {
			followed = true;
			res.end("{}");
			return;
		}
		res.writeHead(307, { Location: "/elsewhere" });
		res.end();
	};
	await expect(agent().deleteRecoveryPoint("a", "b")).rejects.toMatchObject({
		code: "AGENT_UNAVAILABLE",
	});
	expect(followed).toBe(false);
});

test("a hanging agent times out", async () => {
	handler = () => {};
	await expect(
		agent({ create: 100, delete: 100 }).createRecoveryPoint("p", REQ),
	).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
});

test("an agent error body keeps its code", async () => {
	handler = (_req, res) => {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "bad" } }));
	};
	await expect(agent().createRecoveryPoint("p", REQ)).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
});

test("a good reply is parsed", async () => {
	handler = (req, res) => {
		expect(req.headers.authorization).toBe(`Bearer ${"t".repeat(64)}`);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ created: false, fingerprint: "a".repeat(64) }));
	};
	await expect(agent().createRecoveryPoint("p", REQ)).resolves.toEqual({
		created: false,
		fingerprint: "a".repeat(64),
	});
});

test("a reply that breaks mid-body is a failed agent", async () => {
	handler = (_req, res) => {
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Content-Length": "1000",
		});
		res.write('{"created":');
		setTimeout(() => res.destroy(), 20);
	};
	await expect(agent().createRecoveryPoint("p", REQ)).rejects.toMatchObject({
		code: "AGENT_UNAVAILABLE",
	});
});

test("an empty reply to a delete is success", async () => {
	handler = (_req, res) => {
		res.writeHead(204);
		res.end();
	};
	await expect(agent().deleteRecoveryPoint("a", "b")).resolves.toBeUndefined();
});

test("an agent error without a readable body is unavailable", async () => {
	handler = (_req, res) => {
		res.writeHead(500);
		res.end();
	};
	await expect(agent().deleteRecoveryPoint("a", "b")).rejects.toMatchObject({
		code: "AGENT_UNAVAILABLE",
	});
});

test("the docker inventory is null on a redirect, an oversize reply or a bad shape", async () => {
	handler = (_req, res) => {
		res.writeHead(307, { Location: "/elsewhere" });
		res.end();
	};
	await expect(fetchDockerInventory("127.0.0.1", port, "t")).resolves.toBeNull();
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(`"${"x".repeat(9 * 1024 * 1024)}"`);
	};
	await expect(fetchDockerInventory("127.0.0.1", port, "t")).resolves.toBeNull();
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	};
	await expect(fetchDockerInventory("127.0.0.1", port, "t")).resolves.toBeNull();
});

test("the archive listing is fetched with GET and checked against the contract", async () => {
	const archive = {
		projectId: crypto.randomUUID(),
		pointId: crypto.randomUUID(),
		modifiedAt: new Date().toISOString(),
	};
	let seen = "";
	handler = (req, res) => {
		seen = `${req.method} ${req.url}`;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ archives: [archive] }));
	};
	expect(await agent().listRecoveryArchives()).toEqual({ archives: [archive] });
	expect(seen).toBe("GET /recovery-points");

	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ archives: [{ ...archive, pointId: "../x" }] }));
	};
	await expect(agent().listRecoveryArchives()).rejects.toThrow();

	// A list longer than any honest volume holds is refused (SPEC.md §24).
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ archives: Array.from({ length: 20_001 }, () => archive) }),
		);
	};
	await expect(agent().listRecoveryArchives()).rejects.toThrow();
});
