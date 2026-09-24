/**
 * The instructor role and the Course page (docs/EPIC-13.md rulings 4, 5,
 * 23 and 24; SPEC.md sections 5.2 and 24).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { WEB_ORIGIN } from "./helpers";
import { type LaunchOptions, launchAs, ltiUsers, openCourseTab } from "./lti-helpers";

async function launchInNewContext(
	browser: Browser,
	options: LaunchOptions,
): Promise<Page> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const page = await context.newPage();
	await launchAs(page, options);
	return page;
}

test("an instructor sees the student who launched before on the Course page", async ({
	browser,
}) => {
	const sam = await launchInNewContext(browser, { person: "sam", course: "cs101" });
	await sam.context().close();

	const ivy = await launchInNewContext(browser, { person: "ivy", course: "cs101" });
	try {
		const me = (await (await ivy.request.get("/auth/me")).json()) as { role: string };
		expect(me.role).toBe("instructor");

		const course = await openCourseTab(ivy);
		await expect(course).toHaveURL(/\/course\/[^/]+$/);
		await expect(
			course.getByRole("heading", { level: 1, name: "CS 101 Intro to Programming" }),
		).toBeVisible();

		const table = course.getByRole("table", {
			name: "People who have opened Portikus from this course",
		});
		const samRow = table.getByRole("row", { name: /Sam Student/ });
		await expect(samRow).toBeVisible();
		await expect(samRow.getByRole("cell").first()).toHaveText("Student");
		const ivyRow = table.getByRole("row", { name: /Ivy Instructor/ });
		await expect(ivyRow.getByRole("cell").first()).toHaveText("Instructor");

		// No emails or subjects reach the browser (ruling 23). The user id does,
		// so the instructor can remove a member (Epic 13.1 T6).
		const courses = (await (await ivy.request.get("/courses")).json()) as {
			id: string;
		}[];
		const cs101 = courses[0];
		expect(cs101).toBeDefined();
		const members = await ivy.request.get(`/courses/${cs101?.id}/members`);
		expect(members.status()).toBe(200);
		const text = await members.text();
		expect(text).not.toContain("@mock-lms.test");
		expect(text).not.toContain("5d0c1c7e-");
		const [samUser] = await ltiUsers("sam");
		expect(text).toContain(samUser?.id ?? "no-such-id");
	} finally {
		await ivy.context().close();
	}
});

test("a student gets no course list and a 404 for a course's members", async ({
	browser,
}) => {
	const ivy = await launchInNewContext(browser, { person: "ivy", course: "cs101" });
	const courses = (await (await ivy.request.get("/courses")).json()) as {
		id: string;
	}[];
	await ivy.context().close();
	const courseId = courses[0]?.id;
	expect(courseId).toBeDefined();

	const sam = await launchInNewContext(browser, { person: "sam", course: "cs101" });
	try {
		const list = await sam.request.get("/courses");
		expect(list.status()).toBe(200);
		expect(await list.json()).toEqual([]);
		expect((await sam.request.get(`/courses/${courseId}/members`)).status()).toBe(404);

		await sam.goto(`/course/${courseId}`);
		await expect(
			sam.getByText("This course was not found, or you are not an instructor in it."),
		).toBeVisible({ timeout: 15_000 });
	} finally {
		await sam.context().close();
	}
});

test("an institution administrator from the LMS becomes an instructor, never an administrator", async ({
	browser,
}) => {
	const ada = await launchInNewContext(browser, { person: "ada", course: "cs101" });
	try {
		const me = (await (await ada.request.get("/auth/me")).json()) as { role: string };
		expect(me.role).toBe("instructor");
		const rows = await ltiUsers("ada");
		expect(rows.map((r) => r.role)).toEqual(["instructor"]);
		await expect(ada.getByRole("link", { name: "Course" })).toBeVisible();
	} finally {
		await ada.context().close();
	}
});

test("an instructor is refused every administrator page and route", async ({
	browser,
}) => {
	const ivy = await launchInNewContext(browser, { person: "ivy", course: "cs101" });
	try {
		await ivy.getByTestId("me").click();
		await expect(ivy.getByTestId("admin-link")).toHaveCount(0);
		await ivy.keyboard.press("Escape");

		for (const path of [
			"/admin/settings",
			"/admin/workspaces",
			"/admin/users",
			"/admin/health",
			"/admin/audit",
		]) {
			const response = await ivy.request.get(path);
			expect(response.status(), path).toBe(403);
		}

		await ivy.goto("/admin");
		await expect(ivy).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
		await expect(ivy.getByTestId("page-not-authorized")).toBeVisible();
	} finally {
		await ivy.context().close();
	}
});
