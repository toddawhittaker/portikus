import type { AgentCodingAgentStatus } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withProjects } from "./coding-agents.js";

const skip = !hasTestDb();
let tdb: TestDb;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
});

async function workspace(label: string): Promise<string> {
	const owner = await insertTestUser(tdb.db);
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label,
			owner_user_id: owner,
			incus_instance_name: `ws-${label}`,
			state: "running",
			desired_state: "running",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function project(workspaceId: string, slug: string): Promise<string> {
	const row = await tdb.db
		.insertInto("projects")
		.values({
			workspace_id: workspaceId,
			slug,
			name: slug,
			path: `/home/student/projects/${slug}`,
			source: "new",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function terminal(
	workspaceId: string,
	projectId: string | null,
): Promise<string> {
	const row = await tdb.db
		.insertInto("terminals")
		.values({
			workspace_id: workspaceId,
			name: "Terminal",
			cwd: "/home/student",
			project_id: projectId,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function state(terminalId: string): AgentCodingAgentStatus {
	return {
		terminalId,
		agent: "claude",
		state: "needs-input",
		since: "2026-11-01T12:00:00.000Z",
		subagents: [],
	};
}

test.skipIf(skip)(
	"each terminal gets the project the database holds for it",
	async () => {
		const ws = await workspace("one");
		const a = await project(ws, "alpha");
		const b = await project(ws, "beta");
		const ta = await terminal(ws, a);
		const tb = await terminal(ws, b);

		const joined = await withProjects(tdb.db, ws, [state(ta), state(tb)]);
		expect(joined).toEqual([
			{ ...state(ta), projectId: a, name: "Terminal" },
			{ ...state(tb), projectId: b, name: "Terminal" },
		]);
	},
);

test.skipIf(skip)(
	"a terminal id the database does not hold for this workspace is dropped",
	async () => {
		const mine = await workspace("mine");
		const theirs = await workspace("theirs");
		const myProject = await project(mine, "alpha");
		const theirProject = await project(theirs, "gamma");
		const own = await terminal(mine, myProject);
		const foreign = await terminal(theirs, theirProject);
		const unknown = crypto.randomUUID();

		const joined = await withProjects(tdb.db, mine, [
			state(foreign),
			state(unknown),
			state(own),
		]);
		expect(joined.map((one) => one.terminalId)).toEqual([own]);
	},
);

test.skipIf(skip)("a terminal outside any project is dropped", async () => {
	const ws = await workspace("loose");
	const loose = await terminal(ws, null);
	expect(await withProjects(tdb.db, ws, [state(loose)])).toEqual([]);
});

test.skipIf(skip)("an empty list needs no query", async () => {
	expect(await withProjects(tdb.db, crypto.randomUUID(), [])).toEqual([]);
});

test.skipIf(skip)(
	"a terminal's subagent rows reach the browser unchanged",
	async () => {
		const ws = await workspace("subagents");
		const p = await project(ws, "alpha");
		const t = await terminal(ws, p);
		const subagents: AgentCodingAgentStatus["subagents"] = [
			{
				id: "toolu_01ABC",
				type: "Explore",
				description: "Find the parser",
				state: "finished",
				since: "2026-11-01T12:00:01.000Z",
			},
		];
		const joined = await withProjects(tdb.db, ws, [{ ...state(t), subagents }]);
		expect(joined[0]?.subagents).toEqual(subagents);
	},
);
