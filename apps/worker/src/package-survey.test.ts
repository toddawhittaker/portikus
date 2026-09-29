import type { AddedPackagesResponse } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { createPackageSurvey, utcDay } from "./package-survey.js";

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

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

/** A controller that answers each instance with its own list. */
class ListsController extends FakeControllerClient {
	lists = new Map<string, AddedPackagesResponse | Error>();
	override async addedPackages(name: string): Promise<AddedPackagesResponse> {
		this.calls.push({ method: "addedPackages", args: [name] });
		const answer =
			this.lists.get(name) ?? new ControllerClientError("NOT_FOUND", "none");
		if (answer instanceof Error) throw answer;
		return answer;
	}
}

async function insertWorkspace(
	state = "running",
): Promise<{ id: string; instance: string }> {
	counter++;
	const instance = `ws-survey-${counter}`;
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: instance,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: instance,
			state,
			desired_state: state,
			image_version: "2026.09.9",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, instance };
}

function build(at: { now: Date }) {
	const controller = new ListsController();
	const { logger, lines } = collectingLogger();
	const tick = createPackageSurvey({
		db: tdb.db,
		controller,
		logger,
		now: () => at.now,
	});
	const reads = () => controller.calls.filter((c) => c.method === "addedPackages");
	return { controller, lines, tick, reads };
}

async function days() {
	return tdb.db
		.selectFrom("package_survey_days")
		.select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"), "surveyed"])
		.orderBy("day")
		.execute();
}

async function counts() {
	return tdb.db
		.selectFrom("package_survey_counts")
		.select([
			sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"),
			"package",
			"workspaces",
		])
		.orderBy("day")
		.orderBy("package")
		.execute();
}

const list = (...packages: string[]) => ({ image: "2026.09.9", packages });

test("the survey day is the UTC day", () => {
	expect(utcDay(new Date("2026-09-27T23:30:00-04:00"))).toBe("2026-09-28");
});

test.skipIf(skip)("counts each package once per workspace that added it", async () => {
	const a = await insertWorkspace();
	const b = await insertWorkspace();
	const c = await insertWorkspace();
	const at = { now: new Date("2026-09-27T10:00:00Z") };
	const { controller, tick } = build(at);
	controller.lists.set(a.instance, list("python3-venv", "htop"));
	controller.lists.set(b.instance, list("python3-venv"));
	controller.lists.set(c.instance, list());

	await tick();

	expect(await days()).toEqual([{ day: "2026-09-27", surveyed: 3 }]);
	expect(await counts()).toEqual([
		{ day: "2026-09-27", package: "htop", workspaces: 1 },
		{ day: "2026-09-27", package: "python3-venv", workspaces: 2 },
	]);
});

test.skipIf(skip)(
	"reads a workspace once per UTC day, however often it ticks",
	async () => {
		const a = await insertWorkspace();
		const at = { now: new Date("2026-09-27T10:00:00Z") };
		const { controller, tick, reads } = build(at);
		controller.lists.set(a.instance, list("htop"));

		await tick();
		at.now = new Date("2026-09-27T23:59:00Z");
		await tick();
		expect(reads()).toHaveLength(1);
		expect(await counts()).toEqual([
			{ day: "2026-09-27", package: "htop", workspaces: 1 },
		]);

		at.now = new Date("2026-09-28T00:01:00Z");
		await tick();
		expect(reads()).toHaveLength(2);
		expect(await days()).toEqual([
			{ day: "2026-09-27", surveyed: 1 },
			{ day: "2026-09-28", surveyed: 1 },
		]);
	},
);

test.skipIf(skip)("two ticks at once still count a workspace once", async () => {
	const a = await insertWorkspace();
	const at = { now: new Date("2026-09-27T10:00:00Z") };
	const first = build(at);
	const second = build(at);
	first.controller.lists.set(a.instance, list("htop"));
	second.controller.lists.set(a.instance, list("htop"));

	await Promise.all([first.tick(), second.tick()]);

	expect(await days()).toEqual([{ day: "2026-09-27", surveyed: 1 }]);
	expect(await counts()).toEqual([
		{ day: "2026-09-27", package: "htop", workspaces: 1 },
	]);
});

test.skipIf(skip)("only running workspaces are surveyed", async () => {
	await insertWorkspace("stopped");
	const at = { now: new Date("2026-09-27T10:00:00Z") };
	const { tick, reads } = build(at);
	await tick();
	expect(reads()).toHaveLength(0);
});

test.skipIf(skip)(
	"a workspace with no list is marked for the day but not surveyed",
	async () => {
		const a = await insertWorkspace();
		const b = await insertWorkspace();
		const at = { now: new Date("2026-09-27T10:00:00Z") };
		const { controller, tick, reads } = build(at);
		const c = await insertWorkspace();
		controller.lists.set(a.instance, { image: null, packages: [] });
		controller.lists.set(
			b.instance,
			new ControllerClientError("BAD_REQUEST", "too big"),
		);
		controller.lists.set(c.instance, new ControllerClientError("NOT_FOUND", "gone"));

		await tick();
		await tick();

		expect(reads()).toHaveLength(3);
		expect(await days()).toEqual([]);
	},
);

test.skipIf(skip)("an unreachable controller is retried on the next tick", async () => {
	const a = await insertWorkspace();
	const at = { now: new Date("2026-09-27T10:00:00Z") };
	const { controller, tick, lines } = build(at);
	controller.lists.set(
		a.instance,
		new ControllerClientError("INCUS_UNAVAILABLE", "down"),
	);

	await tick();
	expect(await days()).toEqual([]);
	expect(lines.some((line) => line.msg === "package survey read failed")).toBe(true);

	controller.lists.set(a.instance, list("htop"));
	await tick();
	expect(await days()).toEqual([{ day: "2026-09-27", surveyed: 1 }]);
});

test.skipIf(skip)("days older than 90 are pruned with their counts", async () => {
	await tdb.db
		.insertInto("package_survey_days")
		.values([
			{ day: "2026-06-28", surveyed: 1 },
			{ day: "2026-06-29", surveyed: 1 },
		])
		.execute();
	await tdb.db
		.insertInto("package_survey_counts")
		.values([
			{ day: "2026-06-28", package: "htop", workspaces: 1 },
			{ day: "2026-06-29", package: "htop", workspaces: 1 },
		])
		.execute();
	const at = { now: new Date("2026-09-27T10:00:00Z") };
	const { tick } = build(at);

	await tick();

	expect(await days()).toEqual([{ day: "2026-06-29", surveyed: 1 }]);
	expect(await counts()).toEqual([
		{ day: "2026-06-29", package: "htop", workspaces: 1 },
	]);
});

test.skipIf(skip)(
	"no survey table has a column naming a workspace or user",
	async () => {
		const columns = await sql<{ table_name: string; column_name: string }>`
		select table_name, column_name from information_schema.columns
		where table_name in ('package_survey_days', 'package_survey_counts')
		order by table_name, ordinal_position`.execute(tdb.db);
		expect(columns.rows).toEqual([
			{ table_name: "package_survey_counts", column_name: "day" },
			{ table_name: "package_survey_counts", column_name: "package" },
			{ table_name: "package_survey_counts", column_name: "workspaces" },
			{ table_name: "package_survey_days", column_name: "day" },
			{ table_name: "package_survey_days", column_name: "surveyed" },
		]);
	},
);
