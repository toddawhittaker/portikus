import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * Project routes (SPEC.md §7, §26). The row is the record; the directory
 * belongs to the workspace agent.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const TEMPLATES = "Starter=https://example.com/starter.git";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;

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
	agent.terminals.clear();
	agent.projects.clear();
	app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		PROJECT_TEMPLATES: TEMPLATES,
		projectTemplates: [{ name: "Starter", url: "https://example.com/starter.git" }],
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeRunningWorkspace(alice);
	return async () => {
		await app.close();
	};
});

function createProject(jar: CookieJar, id: string, payload: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/projects`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

function listProjects(jar: CookieJar, id: string, query = "") {
	return app.inject({
		method: "GET",
		url: `/workspaces/${id}/projects${query}`,
		headers: { cookie: jar.cookieHeader() },
	});
}

test.skipIf(skip)("create a new project, then list it", async () => {
	const created = await createProject(alice, workspaceId, {
		name: "My First Project",
		source: "new",
	});
	expect(created.statusCode).toBe(201);
	const project = created.json();
	expect(project.slug).toBe("my-first-project");
	expect(project.path).toBe("/home/student/projects/my-first-project");
	expect(project.source).toBe("new");
	expect(project.isGitRepo).toBe(true);
	expect(agent.projects.has("my-first-project")).toBe(true);

	const listed = await listProjects(alice, workspaceId);
	expect(listed.statusCode).toBe(200);
	expect(listed.json().projects).toHaveLength(1);
	expect(listed.json().projects[0].missing).toBe(false);
});

test.skipIf(skip)("a name with no usable characters is refused", async () => {
	const created = await createProject(alice, workspaceId, {
		name: "!!!",
		source: "new",
	});
	expect(created.statusCode).toBe(400);
	expect(created.json().code).toBe("INVALID_SLUG");
});

test.skipIf(skip)("a duplicate slug is refused", async () => {
	await createProject(alice, workspaceId, { name: "notes", source: "new" });
	const again = await createProject(alice, workspaceId, {
		name: "Notes",
		source: "new",
	});
	expect(again.statusCode).toBe(409);
	expect(again.json().code).toBe("PROJECT_EXISTS");
});

test.skipIf(skip)("a clone url the platform will not accept is refused", async () => {
	const created = await createProject(alice, workspaceId, {
		name: "sneaky",
		source: "clone",
		url: "file:///etc/passwd",
	});
	expect(created.statusCode).toBe(400);
	expect(created.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)("a clone that fails leaves no project row", async () => {
	const created = await createProject(alice, workspaceId, {
		name: "broken",
		source: "clone",
		url: "https://example.com/fail.git",
	});
	expect(created.statusCode).toBe(400);
	expect(created.json().code).toBe("GIT_FAILED");
	const rows = await testDb.db.selectFrom("projects").selectAll().execute();
	expect(rows).toHaveLength(0);
});

test.skipIf(skip)("templates are listed and instantiated by name", async () => {
	const templates = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/templates`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(templates.statusCode).toBe(200);
	expect(templates.json().templates).toEqual([
		{ name: "Starter", url: "https://example.com/starter.git" },
	]);

	const created = await createProject(alice, workspaceId, {
		name: "from template",
		source: "template",
		template: "Starter",
	});
	expect(created.statusCode).toBe(201);
	expect(created.json().source).toBe("template");

	const unknown = await createProject(alice, workspaceId, {
		name: "nope",
		source: "template",
		template: "Missing",
	});
	expect(unknown.statusCode).toBe(400);
	expect(unknown.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)(
	"discovery adds a row for a Git directory and marks a vanished one missing",
	async () => {
		agent.projects.set("found", { isGitRepo: true });
		agent.projects.set("plain", { isGitRepo: false });

		const listed = await listProjects(alice, workspaceId);
		const projects = listed.json().projects as Array<Record<string, unknown>>;
		const first = projects[0] as Record<string, unknown>;
		expect(projects.map((p) => p.slug)).toEqual(["found"]);
		expect(first.source).toBe("discovered");
		expect(first.name).toBe("found");
		expect(first.isGitRepo).toBe(true);

		// The directory goes away: the row stays, marked missing.
		agent.projects.delete("found");
		const after = await listProjects(alice, workspaceId);
		expect(after.json().projects[0].missing).toBe(true);
		expect(after.json().projects[0].isGitRepo).toBe(false);
	},
);

test.skipIf(skip)("an archived slug is never re-added by discovery", async () => {
	const created = await createProject(alice, workspaceId, {
		name: "old work",
		source: "new",
	});
	const project = created.json();

	const archived = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/projects/${project.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { state: "archived" },
	});
	expect(archived.statusCode).toBe(200);
	expect(archived.json().archivedAt).not.toBeNull();

	const events = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "project.archived")
		.execute();
	expect(events).toHaveLength(1);
	expect(events[0]?.target).toBe(project.id);

	// The directory is still there, so discovery could be tempted to re-add it.
	const active = await listProjects(alice, workspaceId);
	expect(active.json().projects).toHaveLength(0);
	const rows = await testDb.db.selectFrom("projects").selectAll().execute();
	expect(rows).toHaveLength(1);

	const archivedList = await listProjects(alice, workspaceId, "?state=archived");
	expect(archivedList.json().projects).toHaveLength(1);

	const back = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/projects/${project.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { state: "active" },
	});
	expect(back.statusCode).toBe(200);
	expect(back.json().archivedAt).toBeNull();
});

test.skipIf(skip)("rename moves the directory and rewrites terminal cwds", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "essay", source: "new" })
	).json();

	const terminal = (
		await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/terminals`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { projectId: project.id },
		})
	).json();
	expect(terminal.cwd).toBe("/home/student/projects/essay");
	expect(terminal.projectId).toBe(project.id);

	// A terminal deeper inside the project moves with it too.
	await testDb.db
		.updateTable("terminals")
		.set({ cwd: "/home/student/projects/essay/src" })
		.where("id", "=", terminal.id)
		.execute();

	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/projects/${project.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "Final Essay" },
	});
	expect(renamed.statusCode).toBe(200);
	expect(renamed.json().slug).toBe("final-essay");
	expect(renamed.json().path).toBe("/home/student/projects/final-essay");
	expect(agent.projects.has("final-essay")).toBe(true);
	expect(agent.projects.has("essay")).toBe(false);

	const row = await testDb.db
		.selectFrom("terminals")
		.selectAll()
		.where("id", "=", terminal.id)
		.executeTakeFirstOrThrow();
	expect(row.cwd).toBe("/home/student/projects/final-essay/src");
});

function deleteProject(jar: CookieJar, id: string, projectId: string, slug: string) {
	return app.inject({
		method: "DELETE",
		url: `/workspaces/${id}/projects/${projectId}`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { slug },
	});
}

test.skipIf(skip)(
	"delete removes the row, its terminals and the directory",
	async () => {
		const project = (
			await createProject(alice, workspaceId, { name: "doomed", source: "new" })
		).json();
		const inside = (
			await app.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/terminals`,
				headers: csrfHeaders(alice, PUBLIC_URL),
				payload: { projectId: project.id },
			})
		).json();
		// A terminal elsewhere in the workspace must survive.
		const elsewhere = (
			await app.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/terminals`,
				headers: csrfHeaders(alice, PUBLIC_URL),
				payload: { cwd: "/home/student" },
			})
		).json();

		const deleted = await deleteProject(alice, workspaceId, project.id, "doomed");
		expect(deleted.statusCode).toBe(204);
		expect(agent.projects.has("doomed")).toBe(false);
		expect(
			await testDb.db
				.selectFrom("projects")
				.selectAll()
				.where("id", "=", project.id)
				.executeTakeFirst(),
		).toBeUndefined();

		const rows = await testDb.db.selectFrom("terminals").selectAll().execute();
		const ended = rows.find((row) => row.id === inside.id);
		expect(ended?.ended_at).not.toBeNull();
		expect(agent.terminals.has(inside.id)).toBe(false);
		expect(rows.find((row) => row.id === elsewhere.id)?.ended_at).toBeNull();

		const audit = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "project.deleted")
			.executeTakeFirstOrThrow();
		expect(audit.target).toBe(project.id);
		expect(audit.metadata).toMatchObject({ slug: "doomed", name: "doomed" });
		expect(typeof (audit.metadata as { ip: string }).ip).toBe("string");
	},
);

test.skipIf(skip)("a slug that does not match deletes nothing", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "keeper", source: "new" })
	).json();

	const wrong = await deleteProject(alice, workspaceId, project.id, "keepers");
	expect(wrong.statusCode).toBe(400);
	expect(wrong.json().code).toBe("VALIDATION_FAILED");
	expect(wrong.json().message).toBe("The slug you typed does not match");
	expect(agent.projects.has("keeper")).toBe(true);
	expect(await testDb.db.selectFrom("projects").selectAll().execute()).toHaveLength(1);
	expect(
		await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "project.deleted")
			.execute(),
	).toHaveLength(0);
});

test.skipIf(skip)(
	"a project whose directory is already gone still deletes",
	async () => {
		const project = (
			await createProject(alice, workspaceId, { name: "ghost", source: "new" })
		).json();
		agent.projects.delete("ghost");

		const deleted = await deleteProject(alice, workspaceId, project.id, "ghost");
		expect(deleted.statusCode).toBe(204);
		expect(await testDb.db.selectFrom("projects").selectAll().execute()).toHaveLength(
			0,
		);
	},
);

test.skipIf(skip)("rename onto an existing slug is refused", async () => {
	const first = (
		await createProject(alice, workspaceId, { name: "one", source: "new" })
	).json();
	await createProject(alice, workspaceId, { name: "two", source: "new" });

	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/projects/${first.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "Two" },
	});
	expect(renamed.statusCode).toBe(409);
	expect(renamed.json().code).toBe("PROJECT_EXISTS");
	expect(agent.projects.has("one")).toBe(true);
});

test.skipIf(skip)("duplicate copies the directory into a new project", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "lab", source: "new" })
	).json();

	const copy = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects/${project.id}/duplicate`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "Lab copy" },
	});
	expect(copy.statusCode).toBe(201);
	expect(copy.json().slug).toBe("lab-copy");
	expect(agent.projects.has("lab-copy")).toBe(true);

	const again = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects/${project.id}/duplicate`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "Lab copy" },
	});
	expect(again.statusCode).toBe(409);
});

test.skipIf(skip)(
	"Initialize Git turns a plain directory into a repository",
	async () => {
		const project = (
			await createProject(alice, workspaceId, {
				name: "plain",
				source: "new",
				gitInit: false,
			})
		).json();
		expect(project.isGitRepo).toBe(false);

		const initialized = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/projects/${project.id}/git-init`,
			headers: csrfHeaders(alice, PUBLIC_URL),
		});
		expect(initialized.statusCode).toBe(200);
		expect(initialized.json().isGitRepo).toBe(true);
		expect(agent.projects.get("plain")?.isGitRepo).toBe(true);
	},
);

test.skipIf(skip)("download streams a zip named after the slug", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "report", source: "new" })
	).json();

	const downloaded = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${project.id}/download`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(downloaded.statusCode).toBe(200);
	expect(downloaded.headers["content-type"]).toBe("application/zip");
	expect(downloaded.headers["content-disposition"]).toBe(
		'attachment; filename="report.zip"',
	);
	// "PK" is the zip magic number.
	expect(downloaded.rawPayload.subarray(0, 2).toString()).toBe("PK");
});

test.skipIf(skip)("a layout is stored and read back", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "layout", source: "new" })
	).json();

	const empty = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${project.id}/layout`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(empty.statusCode).toBe(204);

	const layout = {
		tabs: [
			{
				id: "tab-1",
				root: { type: "leaf", terminalId: crypto.randomUUID() },
			},
		],
	};
	const saved = await app.inject({
		method: "PUT",
		url: `/workspaces/${workspaceId}/projects/${project.id}/layout`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: layout,
	});
	expect(saved.statusCode).toBe(204);

	const read = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${project.id}/layout`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(read.statusCode).toBe(200);
	expect(read.json()).toEqual(layout);

	const bad = await app.inject({
		method: "PUT",
		url: `/workspaces/${workspaceId}/projects/${project.id}/layout`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { tabs: [{ id: "tab-1", root: { type: "leaf" } }] },
	});
	expect(bad.statusCode).toBe(400);
});

test.skipIf(skip)("the listing still works when the agent is down", async () => {
	await createProject(alice, workspaceId, { name: "offline", source: "new" });
	// A port nothing listens on stands in for an agent that is not answering.
	const lonely = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: 1 });
	await lonely.listen({ port: 0, host: "127.0.0.1" });
	const jar = new CookieJar();
	await loginAs(lonely, "alice", jar);

	const listed = await lonely.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects`,
		headers: { cookie: jar.cookieHeader() },
	});
	expect(listed.statusCode).toBe(200);
	expect(listed.json().projects).toHaveLength(1);
	expect(listed.json().projects[0].isGitRepo).toBeNull();
	expect(listed.json().projects[0].missing).toBeNull();
	await lonely.close();
});

test.skipIf(skip)(
	"another student and an administrator get 404 on every project route",
	async () => {
		const project = (
			await createProject(alice, workspaceId, { name: "private", source: "new" })
		).json();

		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const carol = new CookieJar();
		await loginAs(app, "carol", carol);

		for (const jar of [bob, carol]) {
			expect((await listProjects(jar, workspaceId)).statusCode).toBe(404);
			expect(
				(await createProject(jar, workspaceId, { name: "theirs", source: "new" }))
					.statusCode,
			).toBe(404);
			const templates = await app.inject({
				method: "GET",
				url: `/workspaces/${workspaceId}/projects/templates`,
				headers: { cookie: jar.cookieHeader() },
			});
			expect(templates.statusCode).toBe(404);
			const patched = await app.inject({
				method: "PATCH",
				url: `/workspaces/${workspaceId}/projects/${project.id}`,
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { state: "archived" },
			});
			expect(patched.statusCode).toBe(404);
			expect(
				(await deleteProject(jar, workspaceId, project.id, "private")).statusCode,
			).toBe(404);
			const duplicated = await app.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/projects/${project.id}/duplicate`,
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { name: "stolen" },
			});
			expect(duplicated.statusCode).toBe(404);
			const initialized = await app.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/projects/${project.id}/git-init`,
				headers: csrfHeaders(jar, PUBLIC_URL),
			});
			expect(initialized.statusCode).toBe(404);
			const downloaded = await app.inject({
				method: "GET",
				url: `/workspaces/${workspaceId}/projects/${project.id}/download`,
				headers: { cookie: jar.cookieHeader() },
			});
			expect(downloaded.statusCode).toBe(404);
			const layout = await app.inject({
				method: "GET",
				url: `/workspaces/${workspaceId}/projects/${project.id}/layout`,
				headers: { cookie: jar.cookieHeader() },
			});
			expect(layout.statusCode).toBe(404);
		}
	},
);

test.skipIf(skip)(
	"a project of another workspace is not a terminal's project",
	async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const bobWorkspace = await makeRunningWorkspace(bob);
		const foreign = (
			await createProject(bob, bobWorkspace, { name: "bobs", source: "new" })
		).json();

		const terminal = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/terminals`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { projectId: foreign.id },
		});
		expect(terminal.statusCode).toBe(404);
		expect(terminal.json().code).toBe("PROJECT_NOT_FOUND");
	},
);

test.skipIf(skip)("the terminal listing can be filtered by project", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "filtered", source: "new" })
	).json();
	await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { projectId: project.id },
	});
	await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: {},
	});

	const all = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(all.json().terminals).toHaveLength(2);

	const filtered = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals?projectId=${project.id}`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(filtered.json().terminals).toHaveLength(1);
	expect(filtered.json().terminals[0].projectId).toBe(project.id);
});

test.skipIf(skip)("the test hooks seed and remove a directory", async () => {
	const seeded = await fetch(`http://127.0.0.1:${agent.port}/__test/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ slug: "seeded", isGitRepo: true }),
	});
	expect(seeded.status).toBe(204);
	expect((await listProjects(alice, workspaceId)).json().projects).toHaveLength(1);

	const removed = await fetch(`http://127.0.0.1:${agent.port}/__test/projects/seeded`, {
		method: "DELETE",
	});
	expect(removed.status).toBe(204);
	expect((await listProjects(alice, workspaceId)).json().projects[0].missing).toBe(
		true,
	);
});

test.skipIf(skip)("concurrent listings discover the same directory once", async () => {
	agent.projects.set("shared", { isGitRepo: true });

	const listings = await Promise.all([
		listProjects(alice, workspaceId),
		listProjects(alice, workspaceId),
		listProjects(alice, workspaceId),
		listProjects(alice, workspaceId),
	]);
	for (const listing of listings) {
		expect(listing.statusCode).toBe(200);
	}
	const rows = await testDb.db.selectFrom("projects").selectAll().execute();
	expect(rows).toHaveLength(1);
});

test.skipIf(skip)("a listing past the discovery cap is truncated", async () => {
	// Slugs are padded so sorting by slug and sorting as numbers agree.
	for (let index = 0; index < 250; index += 1) {
		agent.projects.set(`dir-${String(index).padStart(3, "0")}`, { isGitRepo: true });
	}

	const listed = await listProjects(alice, workspaceId);
	expect(listed.statusCode).toBe(200);
	const rows = await testDb.db.selectFrom("projects").select("slug").execute();
	expect(rows).toHaveLength(200);
	expect(rows.map((row) => row.slug)).toContain("dir-000");
	expect(rows.map((row) => row.slug)).not.toContain("dir-249");
});

test.skipIf(skip)("an archived listing discovers nothing", async () => {
	agent.projects.set("ondisk", { isGitRepo: true });

	const listed = await listProjects(alice, workspaceId, "?state=archived");
	expect(listed.statusCode).toBe(200);
	expect(listed.json().projects).toHaveLength(0);
	expect(await testDb.db.selectFrom("projects").selectAll().execute()).toHaveLength(0);
});

test.skipIf(skip)("a second clone on the same workspace is refused", async () => {
	const first = createProject(alice, workspaceId, {
		name: "first clone",
		source: "clone",
		url: "https://example.com/slow.git",
	});
	// Let the first request reach the agent before the second arrives.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const second = await createProject(alice, workspaceId, {
		name: "second clone",
		source: "clone",
		url: "https://example.com/slow.git",
	});

	expect(second.statusCode).toBe(409);
	expect(second.json().code).toBe("OPERATION_IN_PROGRESS");
	expect((await first).statusCode).toBe(201);

	// The slot is released, so the next clone goes through.
	const third = await createProject(alice, workspaceId, {
		name: "third clone",
		source: "clone",
		url: "https://example.com/slow.git",
	});
	expect(third.statusCode).toBe(201);
});

test.skipIf(skip)("a running workspace with no agent token answers 503", async () => {
	await testDb.db
		.updateTable("workspaces")
		.set({ agent_token: "" })
		.where("id", "=", workspaceId)
		.execute();

	const created = await createProject(alice, workspaceId, {
		name: "nowhere",
		source: "new",
	});
	expect(created.statusCode).toBe(503);
	expect(created.json().code).toBe("AGENT_UNAVAILABLE");
	expect(created.json().message).toBe("The workspace agent is not reachable.");
});

test.skipIf(skip)("delete waits for another long operation to finish", async () => {
	const project = (
		await createProject(alice, workspaceId, { name: "doomed", source: "new" })
	).json();

	const clone = createProject(alice, workspaceId, {
		name: "slow clone",
		source: "clone",
		url: "https://example.com/slow.git",
	});
	// Let the clone reach the agent and take the slot before the delete arrives.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const refused = await deleteProject(alice, workspaceId, project.id, "doomed");

	expect(refused.statusCode).toBe(409);
	expect(refused.json().code).toBe("OPERATION_IN_PROGRESS");
	expect(refused.json().message).toBe(
		"Another project operation is already running on this workspace.",
	);
	expect(agent.projects.has("doomed")).toBe(true);
	expect((await clone).statusCode).toBe(201);

	// The slot is released, so the delete goes through.
	const deleted = await deleteProject(alice, workspaceId, project.id, "doomed");
	expect(deleted.statusCode).toBe(204);
	expect(agent.projects.has("doomed")).toBe(false);

	// The delete released its own slot too, so the next one is not refused.
	const second = (
		await createProject(alice, workspaceId, { name: "also doomed", source: "new" })
	).json();
	const again = await deleteProject(alice, workspaceId, second.id, "also-doomed");
	expect(again.statusCode).toBe(204);
});

test.skipIf(skip)("a listing with nothing new writes nothing", async () => {
	agent.projects.set("already-here", { isGitRepo: true });
	// The first listing adopts the directory; the second must not write again.
	expect((await listProjects(alice, workspaceId)).statusCode).toBe(200);

	const insertInto = vi.spyOn(testDb.db, "insertInto");
	try {
		const again = await listProjects(alice, workspaceId);
		expect(again.statusCode).toBe(200);
		expect(again.json().projects).toHaveLength(1);
		expect(insertInto).not.toHaveBeenCalled();
	} finally {
		insertInto.mockRestore();
	}
});
