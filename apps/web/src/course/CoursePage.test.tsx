import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const CS101 = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101 Intro to Programming",
	platformName: "canvas",
};
const CS240 = {
	id: "66666666-6666-4666-8666-666666666666",
	title: "CS 240 Data Structures",
	platformName: "moodle",
};

function serve(routes: Record<string, () => Response>) {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === "/me/profile") return json(404, { code: "NOT_FOUND", message: "no" });
		const handler = routes[url];
		if (handler) return handler();
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
}

test("with no courses, the list says how a course appears", async () => {
	serve({ "/courses": () => json(200, []) });
	renderApp("/course");

	expect((await screen.findByTestId("course-empty")).textContent).toContain(
		"as an instructor",
	);
	expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeDefined();
	expect(document.title).toBe("Courses, Portikus");
});

test("with one course, the list opens it directly", async () => {
	serve({
		"/courses": () => json(200, [CS101]),
		[`/courses/${CS101.id}/members`]: () => json(200, { course: CS101, members: [] }),
	});
	const { router } = renderApp("/course");

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/course/${CS101.id}`),
	);
	expect(await screen.findByTestId("course-members-empty")).toBeDefined();
	expect(screen.getByRole("heading", { level: 1, name: CS101.title })).toBeDefined();
});

test("with several courses, each is a link to its members", async () => {
	serve({ "/courses": () => json(200, [CS101, CS240]) });
	renderApp("/course");

	const list = await screen.findByTestId("course-list");
	const links = within(list).getAllByRole("link");
	expect(links.map((link) => link.textContent)).toEqual([CS101.title, CS240.title]);
	expect(links[1]?.getAttribute("href")).toBe(`/course/${CS240.id}`);
	expect(list.textContent).toContain("moodle");
});

test("a failed course list says so", async () => {
	serve({ "/courses": () => json(500, { code: "INTERNAL", message: "boom" }) });
	renderApp("/course");

	expect((await screen.findByTestId("course-error")).textContent).toContain(
		"could not load your courses",
	);
});

test("the members table shows name, role, last launch and workspace state", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(200, {
				course: CS101,
				members: [
					{
						displayName: "Ivy Instructor",
						role: "instructor",
						lastLaunchAt: "2026-09-23T14:05:00.000Z",
						workspaceState: "running",
					},
					{
						displayName: "Sam Student",
						role: "student",
						lastLaunchAt: "2026-09-22T09:00:00.000Z",
						workspaceState: null,
					},
				],
			}),
	});
	renderApp(`/course/${CS101.id}`);

	const table = await screen.findByTestId("course-members");
	const headers = within(table)
		.getAllByRole("columnheader")
		.map((cell) => cell.textContent);
	expect(headers).toEqual(["Name", "Role", "Last launch", "Workspace"]);
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows).toHaveLength(2);
	expect(within(rows[0] as HTMLElement).getByRole("rowheader").textContent).toBe(
		"Ivy Instructor",
	);
	expect(rows[0]?.textContent).toContain("Instructor");
	expect(rows[0]?.textContent).toContain("2026");
	expect(rows[0]?.textContent?.toLowerCase()).toContain("running");
	expect(rows[1]?.textContent).toContain("Student");
	expect(rows[1]?.textContent).toContain("No workspace");
	// Read-only: nothing in the table can be pressed.
	expect(within(table).queryByRole("button")).toBeNull();
	expect(document.title).toBe(`${CS101.title}, Portikus`);
});

test("a course the caller does not teach looks like nothing", async () => {
	serve({});
	renderApp(`/course/${CS240.id}`);

	expect((await screen.findByTestId("course-error")).textContent).toContain(
		"not found",
	);
	expect(screen.queryByTestId("course-members")).toBeNull();
});

test("a failed members request says so", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(500, { code: "INTERNAL", message: "boom" }),
	});
	renderApp(`/course/${CS101.id}`);

	expect((await screen.findByTestId("course-error")).textContent).toContain(
		"could not load this course",
	);
});

test("signed out, the Course page goes to sign-in", async () => {
	stubFetch(() => json(401, { code: "UNAUTHORIZED", message: "no" }));
	const { router } = renderApp("/course");

	await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});
