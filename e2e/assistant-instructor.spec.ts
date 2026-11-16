import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
import {
	ask,
	holdAiSettings,
	openPanel,
	script,
	setAssistant,
} from "./assistant-helpers";
import {
	addSession,
	DEX_ACCOUNT_ISSUER,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";
import { FAKE_MODEL_PORT } from "./ports";

/**
 * The instructor's assistant on the course page and "Who is stuck?" (SPEC.md
 * section 20.5), against the real API and the fake model server. Each test
 * builds its own course, so nothing here touches the seeded LTI courses.
 */

const SOON = { timeout: 15_000 };

let restore: (() => Promise<void>) | undefined;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	// The wait for another spec holding the settings row counts against this hook.
	test.setTimeout(600_000);
	restore = await holdAiSettings();
});
test.afterAll(async () => {
	await restore?.();
});

test.beforeEach(async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
	await setAssistant(page, true);
});

async function person(name: string, role: "instructor" | "student"): Promise<string> {
	const subject = `e2e-${randomUUID()}`;
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, $5) returning id`,
		[DEX_ACCOUNT_ISSUER, subject, `${subject}@example.edu`, name, role],
	);
	if (!row) throw new Error(`could not create ${name}`);
	return row.id;
}

/** A course of its own with one instructor and one student whose last three checks failed. */
async function course(tag: string, student: string) {
	const [ctx] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
		 values ('https://lms.e2e-stuck.test', $1, $2, 'E2E LMS') returning id`,
		[`stuck-${tag}`, `Stuck ${tag}`],
	);
	if (!ctx) throw new Error("could not create the course");
	const instructorId = await person(`E2E Teacher ${tag}`, "instructor");
	const studentId = await person(student, "student");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
		[ctx.id, instructorId, studentId],
	);
	const [ws] = await query<{ id: string }>(
		`insert into workspaces (owner_user_id, label, state) values ($1, $2, 'stopped') returning id`,
		[studentId, `ws-stuck-${tag}`],
	);
	const [project] = await query<{ id: string }>(
		`insert into projects (workspace_id, slug, name, path, source)
		 values ($1, 'app', 'app', '/home/student/projects/app', 'new') returning id`,
		[ws?.id],
	);
	for (const minutes of [30, 20, 10]) {
		await query(
			`insert into check_runs (project_id, check_id, agent_run_id, state, started_at, ended_at, exit_code)
			 values ($1, 'tests', $2, 'failed', now() - make_interval(mins => $3::int),
			         now() - make_interval(mins => $3::int - 1), 1)`,
			[project?.id, randomUUID(), minutes],
		);
	}
	return { courseId: ctx.id, instructorId, studentId };
}

/** What the API sent the model back after the tool call the script named by `tag`. */
async function toolResultFor(tag: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${FAKE_MODEL_PORT}/__requests`);
	const bodies = (await response.json()) as {
		messages: { role: string; content: unknown }[];
	}[];
	const sent = bodies.filter((body) => JSON.stringify(body.messages).includes(tag));
	const tool = sent
		.flatMap((body) => body.messages)
		.filter((message) => message.role === "tool")
		.map((message) => JSON.stringify(message.content));
	return tool.join("\n");
}

async function cleanUp(context: BrowserContext, userIds: string[]) {
	await context.close();
	await query("delete from assistant_conversations where user_id = any($1)", [userIds]);
}

test("an instructor asks the course page's assistant who is stuck", async ({
	browser,
}) => {
	const tag = randomUUID().slice(0, 8);
	const { courseId, instructorId, studentId } = await course(
		tag,
		`Stuck Student ${tag}`,
	);
	await script(`e2e-stuck-${tag}`, [
		{ toolCalls: [{ name: "courses_stuck", arguments: { path: { courseId } } }] },
		{ text: `Stuck Student ${tag} has failed three checks in a row.` },
	]);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await addSession(context, instructorId);
		const page = await context.newPage();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(`/course/${courseId}`);
		// The table works without the AI.
		const table = page.getByTestId("course-stuck");
		await expect(table.getByRole("row", { name: new RegExp(tag) })).toContainText(
			"3 failed checks in a row",
		);
		const panel = await openPanel(page);
		await panel.getByRole("button", { name: "New conversation" }).click();
		await ask(panel, `who is stuck? e2e-stuck-${tag}`);
		await expect(
			panel.getByText(`Stuck Student ${tag} has failed three checks in a row.`),
		).toBeVisible(SOON);
		const [conversation] = await query<{ course_id: string }>(
			"select course_id from assistant_conversations where user_id = $1",
			[instructorId],
		);
		expect(conversation?.course_id).toBe(courseId);
		const result = await toolResultFor(`e2e-stuck-${tag}`);
		expect(result).toContain(studentId);
		expect(result).toContain("3 failed checks in a row");
	} finally {
		await cleanUp(context, [instructorId]);
	}
});

test("an instructor's assistant cannot reach another course's data", async ({
	browser,
}) => {
	const tag = randomUUID().slice(0, 8);
	const mine = await course(`${tag}a`, `Mine ${tag}`);
	const theirs = await course(`${tag}b`, `Theirs ${tag}`);
	await script(`e2e-other-${tag}`, [
		{
			toolCalls: [
				{ name: "courses_stuck", arguments: { path: { courseId: theirs.courseId } } },
			],
		},
		{ text: `That course is not mine ${tag}.` },
	]);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await addSession(context, mine.instructorId);
		const direct = await context.request.get(`/courses/${theirs.courseId}/stuck`);
		expect(direct.status()).toBe(404);
		const page = await context.newPage();
		await page.goto(`/course/${mine.courseId}`);
		const panel = await openPanel(page);
		await panel.getByRole("button", { name: "New conversation" }).click();
		await ask(panel, `e2e-other-${tag}`);
		await expect(panel.getByText(`That course is not mine ${tag}.`)).toBeVisible(SOON);
		const result = await toolResultFor(`e2e-other-${tag}`);
		expect(result).toContain("NOT_FOUND");
		expect(result).not.toContain(theirs.studentId);
	} finally {
		await cleanUp(context, [mine.instructorId]);
	}
});

test("a student sees no Assistant button and is refused the assistant", async ({
	browser,
}) => {
	const tag = randomUUID().slice(0, 8);
	const { courseId, studentId } = await course(tag, `Student ${tag}`);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await addSession(context, studentId);
		const page = await context.newPage();
		await page.goto(`/course/${courseId}`);
		await expect(page.getByTestId("course-error")).toBeVisible(SOON);
		await expect(
			page.getByRole("button", { name: "Assistant", exact: true }),
		).toHaveCount(0);
		expect((await context.request.get("/assistant/status")).status()).toBe(403);
		const created = await context.request.post("/assistant/conversations", {
			headers: { origin: WEB_ORIGIN },
			data: { courseId },
		});
		expect(created.status()).toBe(403);
	} finally {
		await context.close();
	}
});
