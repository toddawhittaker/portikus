import type {
	ActiveCourseMember,
	CourseMember,
	CourseMembersResponse,
} from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { courseMonogram } from "./CourseList.js";
import { memberKey, nextRemovable } from "./CoursePage.js";
import { LIVE_POLL_MS } from "./live/queries.js";

afterEach(() => vi.unstubAllGlobals());

const CS101 = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101 Intro to Programming",
	platformName: "canvas",
	profile: "agentic",
};
const NO_ROSTER = { available: false, syncedAt: null, result: null };
const SAM_ID = "77777777-7777-4777-8777-777777777777";
const CS240 = {
	id: "66666666-6666-4666-8666-666666666666",
	title: "CS 240 Data Structures",
	platformName: "moodle",
	profile: "agentic",
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

test("the header's back link keeps its full name when a narrow bar shortens it", async () => {
	serve({ "/courses": () => json(200, []) });
	renderApp("/course");

	const back = await screen.findByRole("link", { name: "Back to your workspace" });
	expect(back.getAttribute("href")).toBe("/");
	const [full, short] = Array.from(back.children);
	expect(full?.textContent).toBe("Back to your workspace");
	expect(full?.className).toContain("@max-[24rem]:hidden");
	expect(short?.textContent).toBe("Workspace");
	expect(short?.className).toBe("hidden @max-[24rem]:inline");
});

test("one status region says loading, then the answer, without being replaced", async () => {
	let answer: (response: Response) => void = () => {};
	serve({ "/courses": () => json(200, []) });
	const fetch = globalThis.fetch;
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		String(input) === "/courses"
			? new Promise<Response>((resolve) => {
					answer = resolve;
				})
			: fetch(input, init),
	);
	renderApp("/course");

	const status = await screen.findByRole("status");
	await waitFor(() => expect(status.textContent).toBe("Loading courses…"));
	answer(json(200, []));
	await waitFor(() => expect(status.textContent).toContain("as an instructor"));
	expect(screen.getByRole("status")).toBe(status);
});

test("with one course, the list opens it directly", async () => {
	serve({
		"/courses": () => json(200, [CS101]),
		[`/courses/${CS101.id}/members`]: () =>
			json(200, { course: CS101, roster: NO_ROSTER, members: [] }),
	});
	const { router } = renderApp("/course");

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/course/${CS101.id}`),
	);
	expect(await screen.findByTestId("course-members-empty")).toBeDefined();
	expect(screen.getByRole("heading", { level: 1, name: CS101.title })).toBeDefined();
});

test("a course page offers the profile choice between the roster status and the members", async () => {
	serve({
		"/courses": () => json(200, [{ ...CS101, profile: "traditional" }]),
		[`/courses/${CS101.id}/members`]: () =>
			json(200, { course: CS101, roster: NO_ROSTER, members: [] }),
	});
	renderApp(`/course/${CS101.id}`);

	const profile = await screen.findByRole("region", { name: "Student interface" });
	await waitFor(() =>
		expect(
			within(profile).getByRole<HTMLInputElement>("radio", { name: "Traditional" })
				.checked,
		).toBe(true),
	);
	const headings = screen
		.getAllByRole("heading", { level: 2 })
		.map((heading) => heading.textContent);
	// The members come first; the course's settings follow them.
	expect(headings.indexOf("Members")).toBeLessThan(headings.indexOf("Course settings"));
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
				roster: NO_ROSTER,
				members: [
					{
						status: "active",
						userId: USER.id,
						displayName: "Ivy Instructor",
						role: "instructor",
						lastLaunchAt: "2026-09-23T14:05:00.000Z",
						workspaceState: "running",
					},
					{
						status: "active",
						userId: SAM_ID,
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
	expect(headers).toEqual(["Name", "Role", "Last launch", "Workspace", "Actions"]);
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows).toHaveLength(2);
	// The row header is named by the name alone, not the folded role and launch.
	const ivy = within(rows[0] as HTMLElement).getByRole("rowheader", {
		name: "Ivy Instructor",
	});
	expect(ivy.firstChild?.textContent).toBe("Ivy Instructor");
	// A narrow table folds Role and Last launch under the name, and hides their columns.
	const folded = ivy.querySelector(".pk-cell-muted") as HTMLElement;
	expect(folded.className).toContain("@max-2xl:block");
	expect(folded.textContent).toMatch(/^Instructor · , Last launch .*2026/);
	expect(folded.querySelector("time")?.getAttribute("dateTime")).toBeTruthy();
	for (const name of ["Role", "Last launch"]) {
		expect(within(table).getByRole("columnheader", { name }).className).toContain(
			"@max-2xl:hidden",
		);
	}
	expect(table.parentElement?.className).toContain("@container");
	expect(rows[0]?.textContent).toContain("Instructor");
	expect(rows[0]?.textContent).toContain("2026");
	expect(rows[0]?.textContent?.toLowerCase()).toContain("running");
	expect(rows[1]?.textContent).toContain("Student");
	expect(rows[1]?.textContent).toContain("No workspace");
	// Only the other person can be removed, and no cell is a live region.
	const body = table.querySelector("tbody") as HTMLElement;
	expect(
		within(body)
			.getAllByRole("button")
			.map((b) => b.textContent),
	).toEqual([""]);
	expect(
		within(body)
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label")),
	).toEqual(["Actions for Sam Student"]);
	expect(within(table).queryByRole("status")).toBeNull();
	expect(document.title).toBe(`${CS101.title}, Portikus`);
});

test("another instructor has no Remove button, because the learning system manages them", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(200, {
				course: CS101,
				roster: NO_ROSTER,
				members: [
					{
						status: "active",
						userId: SAM_ID,
						displayName: "Tia Teacher",
						role: "instructor",
						lastLaunchAt: "2026-09-22T09:00:00.000Z",
						workspaceState: null,
					},
				],
			}),
	});
	renderApp(`/course/${CS101.id}`);

	const table = await screen.findByTestId("course-members");
	expect(within(table).getByRole("rowheader").firstChild?.textContent).toBe(
		"Tia Teacher",
	);
	expect(
		within(table.querySelector("tbody") as HTMLElement).queryByRole("button"),
	).toBeNull();
});

test("the members table uses the admin page's table and frame", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(200, {
				course: CS101,
				roster: NO_ROSTER,
				members: [
					{
						status: "active",
						userId: SAM_ID,
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
	expect(table.className).toBe("pk-table pk-table--page pk-members-table");
	// The wrap may not scroll, so the header sticks to the scrolling <main>.
	expect(table.parentElement?.className).toContain("pk-table-wrap");
	expect(table.parentElement?.className).toContain("overflow-clip");
	const main = screen.getByTestId("page-course");
	expect(main.getAttribute("data-density")).toBe("compact");
	expect(main.firstElementChild?.className).toContain("max-w-[80rem]");
	// The launch time is machine-readable as well as shown in the local format.
	expect(table.querySelector("time")?.getAttribute("datetime")).toBe(
		"2026-09-22T09:00:00.000Z",
	);
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

/** Opens a member's row menu and chooses Remove from course, as a pointer does. */
async function chooseRemove(name: string): Promise<void> {
	fireEvent.pointerDown(
		await screen.findByRole("button", { name: `Actions for ${name}` }),
		{
			button: 0,
			ctrlKey: false,
		},
	);
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from course" }));
}

function samMember(): ActiveCourseMember {
	return {
		status: "active",
		userId: SAM_ID,
		displayName: "Sam Student",
		role: "student",
		lastLaunchAt: "2026-09-22T09:00:00.000Z",
		workspaceState: null,
	};
}

function roster(): CourseMembersResponse {
	return { course: CS101, roster: NO_ROSTER, members: [samMember()] };
}

test("removing asks first, naming the person and the course, then the row goes", async () => {
	const removeUrl = `/courses/${CS101.id}/members/${SAM_ID}/remove`;
	const calls: string[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === `/courses/${CS101.id}/members`) return json(200, roster());
		if (url === removeUrl) {
			calls.push(init?.method ?? "GET");
			return json(200, {});
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	renderApp(`/course/${CS101.id}`);

	await chooseRemove("Sam Student");
	const dialog = await screen.findByTestId("dialog-remove-member");
	expect(dialog.textContent).toContain(`Remove Sam Student from ${CS101.title}?`);
	expect(dialog.textContent).toContain(
		"They reappear if they open Portikus from the course again.",
	);

	// Cancel leaves the row and sends nothing.
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByTestId("dialog-remove-member")).toBeNull());
	expect(calls).toEqual([]);

	await chooseRemove("Sam Student");
	const again = await screen.findByTestId("dialog-remove-member");
	fireEvent.click(within(again).getByRole("button", { name: "Remove from course" }));

	await waitFor(() =>
		expect(screen.queryByRole("rowheader", { name: "Sam Student" })).toBeNull(),
	);
	expect(calls).toEqual(["POST"]);
	expect(screen.getByTestId("course-removed").textContent).toBe(
		`Removed Sam Student from ${CS101.title}`,
	);
	// Nobody is left, so focus lands on the heading rather than the page body.
	await waitFor(() => expect(document.activeElement?.id).toBe("course-title"));
	expect(screen.queryByTestId("dialog-remove-member")).toBeNull();
});

test("a failed removal keeps the row and says so in the dialog", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () => json(200, roster()),
		[`/courses/${CS101.id}/members/${SAM_ID}/remove`]: () =>
			json(500, { code: "INTERNAL", message: "boom" }),
	});
	renderApp(`/course/${CS101.id}`);

	await chooseRemove("Sam Student");
	const dialog = await screen.findByTestId("dialog-remove-member");
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove from course" }));

	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Portikus could not remove them. Try again.",
	);
	expect(
		within(screen.getByTestId("course-members")).getByText("Sam Student"),
	).toBeDefined();
});

test("after a removal, focus moves to the next row's Remove button", async () => {
	const PAT_ID = "88888888-8888-4888-8888-888888888888";
	let members = [
		...roster().members,
		{ ...samMember(), userId: PAT_ID, displayName: "Pat Student" },
	];
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === `/courses/${CS101.id}/members`)
			return json(200, { course: CS101, roster: NO_ROSTER, members });
		if (url === `/courses/${CS101.id}/members/${SAM_ID}/remove`) {
			members = members.filter((member) => member.userId !== SAM_ID);
			return json(200, {});
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	renderApp(`/course/${CS101.id}`);

	await chooseRemove("Sam Student");
	const dialog = await screen.findByTestId("dialog-remove-member");
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove from course" }));

	await waitFor(() =>
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Actions for Pat Student",
		),
	);
});

test("when only the caller is left, focus moves to the page heading", async () => {
	let members = [
		{
			...samMember(),
			userId: USER.id,
			displayName: USER.displayName,
			role: "instructor" as const,
		},
		samMember(),
	];
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === `/courses/${CS101.id}/members`)
			return json(200, { course: CS101, roster: NO_ROSTER, members });
		if (url === `/courses/${CS101.id}/members/${SAM_ID}/remove`) {
			members = members.filter((member) => member.userId !== SAM_ID);
			return json(200, {});
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	renderApp(`/course/${CS101.id}`);

	await chooseRemove("Sam Student");
	const dialog = await screen.findByTestId("dialog-remove-member");
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove from course" }));

	await waitFor(() => expect(document.activeElement?.id).toBe("course-title"));
	expect(screen.getByTestId("course-members")).toBeTruthy();
});

test("the next Remove button skips the caller's own row and falls back to the previous", () => {
	const member = (userId: string) => ({ ...samMember(), userId });
	const list = [member("a"), member("b"), member("me"), member("c")];
	expect(nextRemovable(list, "a", "me")).toBe("b");
	expect(nextRemovable(list, "b", "me")).toBe("c");
	expect(nextRemovable(list, "c", "me")).toBe("b");
	expect(nextRemovable([member("a"), member("me")], "a", "me")).toBeNull();
	// Instructors have no Remove button, so focus skips them too.
	const teacher = { ...member("t"), role: "instructor" as const };
	expect(nextRemovable([member("a"), teacher, member("c")], "a", "me")).toBe("c");
	expect(nextRemovable([member("a"), teacher], "a", "me")).toBeNull();
});

test("the page explains itself, and Last launch and Remove have help", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(200, { course: CS101, roster: NO_ROSTER, members: [samMember()] }),
	});
	renderApp(`/course/${CS101.id}`);

	const table = await screen.findByTestId("course-members");
	const intro = screen.getByTestId("intro-course");
	expect(intro.textContent).toContain(
		"they come back if they open Portikus from the course again",
	);
	expect(intro.querySelector("a")?.getAttribute("href")).toBe(
		"/help#instructor-course",
	);
	expect(
		within(table).getByRole("button", { name: "About Last launch" }),
	).toBeDefined();
	// The intro explains Remove, so its column has no toggletip of its own.
	expect(within(table).queryByRole("button", { name: "About Remove" })).toBeNull();
});

test("the name search and the state chips narrow the members table, with counts", async () => {
	const PAT_ID = "88888888-8888-4888-8888-888888888888";
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(200, {
				course: CS101,
				roster: NO_ROSTER,
				members: [
					{ ...samMember(), workspaceState: "running" },
					{
						...samMember(),
						userId: PAT_ID,
						displayName: "Pat Student",
						workspaceState: "stopped",
					},
				],
			}),
	});
	renderApp(`/course/${CS101.id}`);

	const table = await screen.findByTestId("course-members");
	const chips = screen.getByTestId("course-members-filter");
	expect(
		within(chips).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed"),
	).toBe("true");
	fireEvent.click(within(chips).getByRole("button", { name: /^Stopped/ }));
	expect(
		within(table)
			.getAllByRole("rowheader")
			.map((cell) => cell.firstChild?.textContent),
	).toEqual(["Pat Student"]);
	fireEvent.click(within(chips).getByRole("button", { name: /^All/ }));
	fireEvent.change(screen.getByTestId("course-members-search"), {
		target: { value: "sam" },
	});
	expect(
		within(table)
			.getAllByRole("rowheader")
			.map((cell) => cell.firstChild?.textContent),
	).toEqual(["Sam Student"]);
	fireEvent.change(screen.getByTestId("course-members-search"), {
		target: { value: "zed" },
	});
	expect(
		(await screen.findByTestId("course-members-none-match")).textContent,
	).toContain("No members match");
});

test("a course's tile shows its number, or the title's initials when it has none", () => {
	expect(courseMonogram("CS 1210: Programming for the Web")).toBe("1210");
	expect(courseMonogram("Databases 2400")).toBe("2400");
	expect(courseMonogram("Web design studio")).toBe("WD");
	expect(courseMonogram("")).toBe("?");
});

/** Serve `routes`, counting each URL asked for. */
function serveCounting(routes: Record<string, () => Response>) {
	const asked = new Map<string, number>();
	stubFetch((url) => {
		asked.set(url, (asked.get(url) ?? 0) + 1);
		if (url === "/auth/me") return json(200, USER);
		const handler = routes[url];
		if (handler) return handler();
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	return (url: string) => asked.get(url) ?? 0;
}

test("the course list reads each course's live help once, without polling", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const asked = serveCounting({
			"/courses": () => json(200, [CS101, CS240]),
			[`/courses/${CS101.id}/members`]: () => json(200, roster()),
			[`/courses/${CS240.id}/members`]: () =>
				json(200, { course: CS240, roster: NO_ROSTER, members: [] }),
			[`/courses/${CS101.id}/live-help`]: () => json(200, { sessions: [] }),
			[`/courses/${CS240.id}/live-help`]: () => json(200, { sessions: [] }),
		});
		renderApp("/course");
		await screen.findByTestId("course-list");
		await waitFor(() => expect(asked(`/courses/${CS240.id}/live-help`)).toBe(1));
		await vi.advanceTimersByTimeAsync(4 * LIVE_POLL_MS);
		expect(asked(`/courses/${CS101.id}/live-help`)).toBe(1);
		expect(asked(`/courses/${CS240.id}/live-help`)).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("live help that cannot load says so, and a course it cannot find is not asked again", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const asked = serveCounting({
			[`/courses/${CS101.id}/members`]: () => json(200, roster()),
		});
		renderApp(`/course/${CS101.id}`);
		expect((await screen.findByTestId("course-live-error")).textContent).toContain(
			"could not load live help",
		);
		await vi.advanceTimersByTimeAsync(4 * LIVE_POLL_MS);
		expect(asked(`/courses/${CS101.id}/live-help`)).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("a course that could not load shows no class summary or live help", async () => {
	serve({
		[`/courses/${CS101.id}/members`]: () =>
			json(500, { code: "INTERNAL", message: "boom" }),
	});
	renderApp(`/course/${CS101.id}`);
	await screen.findByTestId("course-error");
	expect(screen.queryByRole("heading", { name: "Live help" })).toBeNull();
	expect(screen.queryByTestId("course-counts")).toBeNull();
});

test("a roster-only row is keyed by its place in the whole member list", () => {
	const notStarted = (name: string): CourseMember => ({
		status: "not_started",
		userId: null,
		displayName: name,
		role: "student",
		lastLaunchAt: null,
		workspaceState: null,
	});
	const all = [samMember(), notStarted("Nia New"), notStarted("Oz New")];
	const oz = all[2] as CourseMember;
	// Its place in the whole list, which a search or filter does not change.
	expect(memberKey(oz, all)).toBe("roster-2");
	expect(memberKey(samMember(), all)).toBe(SAM_ID);
});
