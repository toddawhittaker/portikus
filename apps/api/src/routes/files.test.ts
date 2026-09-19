import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { MAX_EDITOR_FILE_BYTES, MAX_UPLOAD_BYTES } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * File routes (SPEC.md §11.1, §11.2, §13.5). The control plane brokers every
 * call to the workspace agent and no one but the owner gets through
 * (SPEC.md §5.2, §24.6).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let projectId: string;

/** The sha256 the fake agent uses as an etag, so a test can predict one. */
async function etagOf(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function makeRunningWorkspace(jar: CookieJar): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

/** Put a file straight into the fake agent's filesystem, parents and all. */
function seed(slug: string, path: string, content: string) {
	let walked = "";
	for (const part of path.split("/").slice(0, -1)) {
		walked = walked === "" ? part : `${walked}/${part}`;
		agent.files.set(`${slug}/${walked}`, { type: "dir" });
	}
	agent.files.set(`${slug}/${path}`, {
		type: "file",
		content: Buffer.from(content, "utf8"),
	});
}

function url(route: string, query = ""): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/${route}${query}`;
}

function get(jar: CookieJar, route: string, query = "") {
	return app.inject({
		method: "GET",
		url: url(route, query),
		headers: { cookie: jar.cookieHeader() },
	});
}

/**
 * A stand-in upstream that is not the fake agent: a plain HTTP server the
 * test drives directly, so a wedged, rude or dead agent can be tried.
 */
async function startStub(handler: RequestListener): Promise<Server> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return server;
}

/** An API server whose workspaces talk to `agentPort`, listening on its own. */
async function appAgainst(agentPort: number): Promise<{
	origin: string;
	close: () => Promise<void>;
}> {
	const other = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agentPort });
	await other.listen({ port: 0, host: "127.0.0.1" });
	const port = (other.server.address() as AddressInfo).port;
	return { origin: `http://127.0.0.1:${port}`, close: () => other.close() };
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.projects.clear();
	agent.files.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeRunningWorkspace(alice);
	projectId = (
		await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/projects`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { name: "lab", source: "new" },
		})
	).json().id;
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("the owner reads a tree and a file with its etag", async () => {
	seed("lab", "README.md", "# lab\n");
	seed("lab", "src/main.ts", "export {};\n");

	const tree = await get(alice, "tree");
	expect(tree.statusCode).toBe(200);
	// Directories come first, then files, both alphabetical (SPEC.md §11.2).
	expect(tree.json().entries.map((entry: { name: string }) => entry.name)).toEqual([
		"src",
		"README.md",
	]);
	expect(tree.json().truncated).toBe(false);

	const nested = await get(alice, "tree", "?path=src");
	expect(nested.json().entries).toEqual([
		{ name: "main.ts", type: "file", size: 11, mtimeMs: 0 },
	]);

	const file = await get(alice, "file", "?path=README.md");
	expect(file.statusCode).toBe(200);
	expect(file.body).toBe("# lab\n");
	expect(file.headers.etag).toBe(await etagOf("# lab\n"));
	// The editor saves conditionally on that etag, so no proxy in front of the
	// API may rewrite it: Caddy's gzip compression appends "-gzip" to an etag
	// it compresses, and the next save would then be refused as a conflict
	// nobody caused (issue #157, SPEC.md §13.5).
	expect(file.headers["cache-control"]).toBe("no-transform");
	expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
	expect(file.headers["content-length"]).toBe("6");
});

test.skipIf(skip)("a missing file is a 404 and a directory is a 400", async () => {
	seed("lab", "src/main.ts", "export {};\n");
	const missing = await get(alice, "file", "?path=nope.txt");
	expect(missing.statusCode).toBe(404);
	expect(missing.json().code).toBe("FILE_NOT_FOUND");

	const directory = await get(alice, "tree", "?path=src/main.ts");
	expect(directory.statusCode).toBe(400);
	expect(directory.json().code).toBe("NOT_A_DIRECTORY");
});

test.skipIf(skip)(
	"another student and an administrator get 404 on every file route",
	async () => {
		seed("lab", "README.md", "# lab\n");
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const carol = new CookieJar();
		await loginAs(app, "carol", carol);

		for (const jar of [bob, carol]) {
			expect((await get(jar, "tree")).statusCode).toBe(404);
			expect((await get(jar, "file", "?path=README.md")).statusCode).toBe(404);
			const written = await app.inject({
				method: "PUT",
				url: url("file", "?path=README.md"),
				headers: {
					...csrfHeaders(jar, PUBLIC_URL),
					"content-type": "text/plain",
					"if-none-match": "*",
				},
				payload: "theirs",
			});
			expect(written.statusCode).toBe(404);
			const removed = await app.inject({
				method: "DELETE",
				url: url("file", "?path=README.md"),
				headers: csrfHeaders(jar, PUBLIC_URL),
			});
			expect(removed.statusCode).toBe(404);
			const made = await app.inject({
				method: "POST",
				url: url("mkdir"),
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { path: "theirs" },
			});
			expect(made.statusCode).toBe(404);
			const moved = await app.inject({
				method: "POST",
				url: url("move"),
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { from: "README.md", to: "stolen.md" },
			});
			expect(moved.statusCode).toBe(404);
		}
		// Nothing they tried changed the file.
		expect(agent.files.get("lab/README.md")).toBeDefined();
	},
);

test.skipIf(skip)(
	"a stopped workspace answers 409 rather than calling out",
	async () => {
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped" })
			.where("id", "=", workspaceId)
			.execute();

		const tree = await get(alice, "tree");
		expect(tree.statusCode).toBe(409);
		expect(tree.json().code).toBe("AGENT_UNAVAILABLE");
		const file = await get(alice, "file", "?path=README.md");
		expect(file.statusCode).toBe(409);
	},
);

test.skipIf(skip)(
	"If-None-Match creates a file and refuses a second time",
	async () => {
		const created = await app.inject({
			method: "PUT",
			url: url("file", "?path=notes.md"),
			headers: {
				...csrfHeaders(alice, PUBLIC_URL),
				"content-type": "text/plain",
				"if-none-match": "*",
			},
			payload: "first\n",
		});
		expect(created.statusCode).toBe(200);
		expect(created.json()).toEqual({ etag: await etagOf("first\n"), size: 6 });
		expect(created.headers.etag).toBe(await etagOf("first\n"));
		// The next save is conditional on this etag too (issue #157).
		expect(created.headers["cache-control"]).toBe("no-transform");
		expect(agent.files.get("lab/notes.md")).toEqual({
			type: "file",
			content: Buffer.from("first\n"),
		});

		const again = await app.inject({
			method: "PUT",
			url: url("file", "?path=notes.md"),
			headers: {
				...csrfHeaders(alice, PUBLIC_URL),
				"content-type": "text/plain",
				"if-none-match": "*",
			},
			payload: "second\n",
		});
		expect(again.statusCode).toBe(409);
		expect(again.json().code).toBe("FILE_EXISTS");
	},
);

test.skipIf(skip)("a stale If-Match is refused with the current etag", async () => {
	seed("lab", "notes.md", "on disk\n");
	const current = await etagOf("on disk\n");

	const stale = await app.inject({
		method: "PUT",
		url: url("file", "?path=notes.md"),
		headers: {
			...csrfHeaders(alice, PUBLIC_URL),
			"content-type": "text/plain",
			"if-match": `"${await etagOf("what the browser had\n")}"`,
		},
		payload: "overwrite\n",
	});
	expect(stale.statusCode).toBe(412);
	expect(stale.json().code).toBe("FILE_CHANGED");
	expect(stale.headers.etag).toBe(current);
	// The write did not happen.
	expect(agent.files.get("lab/notes.md")).toEqual({
		type: "file",
		content: Buffer.from("on disk\n"),
	});

	const fresh = await app.inject({
		method: "PUT",
		url: url("file", "?path=notes.md"),
		headers: {
			...csrfHeaders(alice, PUBLIC_URL),
			"content-type": "text/plain",
			"if-match": `"${current}"`,
		},
		payload: "kept\n",
	});
	expect(fresh.statusCode).toBe(200);
	expect(agent.files.get("lab/notes.md")).toEqual({
		type: "file",
		content: Buffer.from("kept\n"),
	});
});

test.skipIf(skip)("a write past the editor cap is refused", async () => {
	const tooBig = "x".repeat(MAX_EDITOR_FILE_BYTES + 1);
	const written = await app.inject({
		method: "PUT",
		url: url("file", "?path=huge.txt"),
		headers: {
			...csrfHeaders(alice, PUBLIC_URL),
			"content-type": "text/plain",
			"if-none-match": "*",
		},
		payload: tooBig,
	});
	expect(written.statusCode).toBe(413);
	expect(written.json().code).toBe("FILE_TOO_LARGE");
});

test.skipIf(skip)("delete, mkdir and move work on the project tree", async () => {
	seed("lab", "old.md", "text\n");

	const made = await app.inject({
		method: "POST",
		url: url("mkdir"),
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { path: "docs" },
	});
	expect(made.statusCode).toBe(201);
	expect(agent.files.get("lab/docs")).toEqual({ type: "dir" });

	const moved = await app.inject({
		method: "POST",
		url: url("move"),
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { from: "old.md", to: "docs/new.md" },
	});
	expect(moved.statusCode).toBe(204);
	expect(agent.files.has("lab/old.md")).toBe(false);
	expect(agent.files.get("lab/docs/new.md")).toEqual({
		type: "file",
		content: Buffer.from("text\n"),
	});

	const clash = await app.inject({
		method: "POST",
		url: url("mkdir"),
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { path: "docs" },
	});
	expect(clash.statusCode).toBe(409);
	expect(clash.json().code).toBe("FILE_EXISTS");

	const removed = await app.inject({
		method: "DELETE",
		url: url("file", "?path=docs"),
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(removed.statusCode).toBe(204);
	expect(agent.files.has("lab/docs")).toBe(false);
	expect(agent.files.has("lab/docs/new.md")).toBe(false);
});

test.skipIf(skip)("a file download is named after its basename", async () => {
	seed("lab", "docs/report.txt", "content\n");
	const downloaded = await get(alice, "file", "?path=docs/report.txt&download=1");
	expect(downloaded.statusCode).toBe(200);
	expect(downloaded.headers["content-disposition"]).toBe(
		`attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
	);
	expect(downloaded.body).toBe("content\n");
});

test.skipIf(skip)("a non-ASCII filename also gets an RFC 5987 name", async () => {
	seed("lab", "résumé.txt", "content\n");
	const downloaded = await get(alice, "file", "?path=r%C3%A9sum%C3%A9.txt&download=1");
	expect(downloaded.statusCode).toBe(200);
	expect(downloaded.headers["content-disposition"]).toBe(
		`attachment; filename="r_sum_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`,
	);
});

test.skipIf(skip)("a directory download streams a zip named after it", async () => {
	seed("lab", "docs/report.txt", "content\n");
	const downloaded = await get(alice, "download", "?path=docs");
	expect(downloaded.statusCode).toBe(200);
	expect(downloaded.headers["content-type"]).toBe("application/zip");
	expect(downloaded.headers["content-disposition"]).toBe(
		`attachment; filename="docs.zip"; filename*=UTF-8''docs.zip`,
	);
	// "PK" is the zip magic number.
	expect(downloaded.rawPayload.subarray(0, 2).toString()).toBe("PK");
});

test.skipIf(skip)(
	"a path that leaves the project never reaches the agent",
	async () => {
		seed("lab", "README.md", "# lab\n");
		for (const path of ["../secrets", "/etc/passwd", "a/../../b"]) {
			const tree = await get(alice, "tree", `?path=${encodeURIComponent(path)}`);
			expect(tree.statusCode).toBe(400);
			expect(tree.json().code).toBe("VALIDATION_FAILED");

			const file = await get(alice, "file", `?path=${encodeURIComponent(path)}`);
			expect(file.statusCode).toBe(400);
			expect(file.json().code).toBe("VALIDATION_FAILED");

			const made = await app.inject({
				method: "POST",
				url: url("mkdir"),
				headers: csrfHeaders(alice, PUBLIC_URL),
				payload: { path },
			});
			expect(made.statusCode).toBe(400);

			const archived = await get(
				alice,
				"download",
				`?path=${encodeURIComponent(path)}`,
			);
			expect(archived.statusCode).toBe(400);
		}
	},
);

test.skipIf(skip)(
	"the agent's own refusal of a bad path becomes a 400 PATH_INVALID",
	async () => {
		// The contract stops a `..` before the agent sees it, so ask the fake
		// directly for the answer the real agent would give (SPEC.md §11.1).
		const refused = await fetch(
			`http://127.0.0.1:${agent.port}/projects/lab/tree?path=${encodeURIComponent("../etc")}`,
			{ headers: { authorization: `Bearer ${AGENT_TOKEN}` } },
		);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
			"PATH_INVALID",
		);
	},
);

test.skipIf(skip)("a binary file is served as octet-stream", async () => {
	agent.files.set("lab/logo.png", {
		type: "file",
		content: Buffer.from([0x89, 0x50, 0x00, 0x01]),
	});
	const file = await get(alice, "file", "?path=logo.png");
	expect(file.statusCode).toBe(200);
	expect(file.headers["content-type"]).toBe("application/octet-stream");
	expect(file.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x00, 0x01]));
});

test.skipIf(skip)("a file past the editor cap is not opened", async () => {
	agent.files.set("lab/huge.txt", {
		type: "file",
		content: Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61),
	});
	const file = await get(alice, "file", "?path=huge.txt");
	expect(file.statusCode).toBe(413);
	expect(file.json().code).toBe("FILE_TOO_LARGE");

	// The same file downloads, because a download is streamed (SPEC.md §11.2).
	const downloaded = await get(alice, "file", "?path=huge.txt&download=1");
	expect(downloaded.statusCode).toBe(200);
	expect(downloaded.rawPayload.length).toBe(MAX_EDITOR_FILE_BYTES + 1);
});

test.skipIf(skip)("the fake agent's test hooks seed and read a file back", async () => {
	const seeded = await fetch(`http://127.0.0.1:${agent.port}/__test/files`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: "lab/docs/notes.md", content: "seeded\n" }),
	});
	expect(seeded.status).toBe(204);
	// The parent directory was created along the way.
	expect(agent.files.get("lab/docs")).toEqual({ type: "dir" });

	const read = await fetch(
		`http://127.0.0.1:${agent.port}/__test/files?path=lab/docs/notes.md`,
	);
	expect(((await read.json()) as { content: string }).content).toBe("seeded\n");

	const removed = await fetch(
		`http://127.0.0.1:${agent.port}/__test/files?path=lab/docs/notes.md`,
		{ method: "DELETE" },
	);
	expect(removed.status).toBe(204);
	expect(agent.files.has("lab/docs/notes.md")).toBe(false);
});

test.skipIf(skip)("the fake agent needs exactly one write condition", async () => {
	const neither = await fetch(
		`http://127.0.0.1:${agent.port}/projects/lab/file?path=notes.md`,
		{
			method: "PUT",
			headers: {
				authorization: `Bearer ${AGENT_TOKEN}`,
				"content-type": "text/plain",
			},
			body: "text",
		},
	);
	expect(neither.status).toBe(400);

	const both = await fetch(
		`http://127.0.0.1:${agent.port}/projects/lab/file?path=notes.md`,
		{
			method: "PUT",
			headers: {
				authorization: `Bearer ${AGENT_TOKEN}`,
				"content-type": "text/plain",
				"if-match": '"abc"',
				"if-none-match": "*",
			},
			body: "text",
		},
	);
	expect(both.status).toBe(400);
});

// --- Agent failures, caps and content types -------------------------------

test.skipIf(skip)("an unreachable agent is a 503, not a 500", async () => {
	// A port that was listening and is now closed refuses at once.
	const dead = await startStub(() => {});
	const port = (dead.address() as AddressInfo).port;
	await new Promise<void>((resolve) => dead.close(() => resolve()));
	const other = await appAgainst(port);
	try {
		for (const route of ["tree", "file?path=README.md"]) {
			const response = await fetch(
				`${other.origin}/workspaces/${workspaceId}/projects/${projectId}/${route}`,
				{ headers: { cookie: alice.cookieHeader() } },
			);
			expect(response.status).toBe(503);
			expect(((await response.json()) as { code: string }).code).toBe(
				"AGENT_UNAVAILABLE",
			);
		}
	} finally {
		await other.close();
	}
});

test.skipIf(skip)("reading a directory as a file is a 400, not a 503", async () => {
	seed("lab", "src/main.ts", "export {};\n");
	const response = await get(alice, "file", "?path=src");
	expect(response.statusCode).toBe(400);
	expect(response.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)(
	"an agent that never answers gives up rather than holding the connection",
	async () => {
		// Accept the connection and say nothing at all.
		const wedged = await startStub(() => {});
		const port = (wedged.address() as AddressInfo).port;
		const other = await appAgainst(port);
		try {
			const read = await fetch(
				`${other.origin}/workspaces/${workspaceId}/projects/${projectId}/file?path=README.md`,
				{ headers: { cookie: alice.cookieHeader() } },
			);
			expect(read.status).toBe(503);

			const written = await fetch(
				`${other.origin}/workspaces/${workspaceId}/projects/${projectId}/file?path=README.md`,
				{
					method: "PUT",
					headers: {
						...csrfHeaders(alice, PUBLIC_URL),
						"content-type": "text/plain",
						"if-none-match": "*",
					},
					body: "text",
				},
			);
			expect(written.status).toBe(503);
		} finally {
			await other.close();
			wedged.closeAllConnections();
			await new Promise<void>((resolve) => wedged.close(() => resolve()));
		}
	},
	30000,
);

test.skipIf(skip)(
	"the control plane stops an upload past the cap itself",
	async () => {
		const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
		// One chunk more than the cap allows.
		let left = Math.ceil(MAX_UPLOAD_BYTES / chunk.length) + 1;
		const payload = new Readable({
			read() {
				this.push(left > 0 ? chunk : null);
				left -= 1;
			},
		});
		const written = await app.inject({
			method: "PUT",
			url: url("file", "?path=huge.bin"),
			headers: {
				...csrfHeaders(alice, PUBLIC_URL),
				"content-type": "application/octet-stream",
				"if-none-match": "*",
			},
			payload,
		});
		expect(written.statusCode).toBe(413);
		expect(written.json().code).toBe("FILE_TOO_LARGE");
		// The refusal is the control plane's own, not one relayed from the agent.
		expect(written.json().message).toBe("That file is larger than the upload limit.");
		expect(agent.files.has("lab/huge.bin")).toBe(false);
	},
	30000,
);

test.skipIf(skip)("an agent's HTML content type is never relayed", async () => {
	const rude = await startStub((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<script>alert(1)</script>");
	});
	const port = (rude.address() as AddressInfo).port;
	const other = await appAgainst(port);
	try {
		const response = await fetch(
			`${other.origin}/workspaces/${workspaceId}/projects/${projectId}/file?path=page.html`,
			{ headers: { cookie: alice.cookieHeader() } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
	} finally {
		await other.close();
		await new Promise<void>((resolve) => rude.close(() => resolve()));
	}
});

test.skipIf(skip)(
	"two downloads of the same file can stream at once",
	async () => {
		// Headers come back, then the body hangs. A single file takes no
		// long-operation slot, so a second download is not made to wait.
		const stalled = await startStub((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write("start");
		});
		const port = (stalled.address() as AddressInfo).port;
		const other = await appAgainst(port);
		const fileUrl = `${other.origin}/workspaces/${workspaceId}/projects/${projectId}/file?path=big.txt&download=1`;
		try {
			const first = await fetch(fileUrl, { headers: { cookie: alice.cookieHeader() } });
			expect(first.status).toBe(200);

			const second = await fetch(fileUrl, {
				headers: { cookie: alice.cookieHeader() },
			});
			expect(second.status).toBe(200);
			await first.body?.cancel();
			await second.body?.cancel();
		} finally {
			await other.close();
			stalled.closeAllConnections();
			await new Promise<void>((resolve) => stalled.close(() => resolve()));
		}
	},
	30000,
);

// --- The fake agent's own behaviour ---------------------------------------

test.skipIf(skip)(
	"the fake agent takes only a literal * as If-None-Match",
	async () => {
		const response = await fetch(
			`http://127.0.0.1:${agent.port}/projects/lab/file?path=notes.md`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${AGENT_TOKEN}`,
					"content-type": "text/plain",
					"if-none-match": '"abc"',
				},
				body: "text",
			},
		);
		expect(response.status).toBe(400);
		expect(agent.files.has("lab/notes.md")).toBe(false);
	},
);

test.skipIf(skip)(
	"the fake agent keeps its files in step with its projects",
	async () => {
		agent.projects.set("lab", { isGitRepo: false });
		seed("lab", "docs/notes.md", "text\n");

		const renamed = await fetch(`http://127.0.0.1:${agent.port}/projects/lab/rename`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${AGENT_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ to: "lab2" }),
		});
		expect(renamed.status).toBe(204);
		expect(agent.files.has("lab/docs/notes.md")).toBe(false);
		expect(agent.files.get("lab2/docs/notes.md")).toEqual({
			type: "file",
			content: Buffer.from("text\n"),
		});

		const copied = await fetch(
			`http://127.0.0.1:${agent.port}/projects/lab2/duplicate`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${AGENT_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ to: "lab3" }),
			},
		);
		expect(copied.status).toBe(201);
		expect(agent.files.get("lab3/docs/notes.md")).toEqual({
			type: "file",
			content: Buffer.from("text\n"),
		});

		const removed = await fetch(`http://127.0.0.1:${agent.port}/projects/lab2`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${AGENT_TOKEN}` },
		});
		expect(removed.status).toBe(204);
		expect(agent.files.has("lab2/docs/notes.md")).toBe(false);
		expect(agent.files.has("lab3/docs/notes.md")).toBe(true);
	},
);
