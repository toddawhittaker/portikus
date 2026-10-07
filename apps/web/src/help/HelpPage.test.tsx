import { ACCOUNT_IMPORT_MAX_ROWS } from "@portikus/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { ADMIN_HELP } from "./content/admin.js";
import { anchorId } from "./HelpDocument.js";
import { helpParts } from "./HelpPage.js";

afterEach(() => {
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

const COURSE = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101",
	platformName: "canvas",
};

function stub(
	role: "student" | "instructor" | "administrator",
	courses: unknown[] = [],
) {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...USER, role });
		if (url === "/courses") return json(200, courses);
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
}

async function partHeadings(title = "Using your workspace"): Promise<string[]> {
	await screen.findByRole("heading", { level: 1, name: title });
	return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

test("helpParts: a student gets only the workspace part", () => {
	expect(helpParts("student", false).map((part) => part.id)).toEqual(["student"]);
});

test("helpParts: an instructor by role gets the instructor part", () => {
	expect(helpParts("instructor", false).map((part) => part.id)).toEqual([
		"student",
		"instructor",
	]);
});

test("helpParts: a student account that teaches a course gets the instructor part", () => {
	expect(helpParts("student", true).map((part) => part.id)).toEqual([
		"student",
		"instructor",
	]);
});

test("helpParts: an administrator gets the instructor part but not the admin part", () => {
	expect(helpParts("administrator", false).map((part) => part.id)).toEqual([
		"student",
		"instructor",
	]);
});

test("a student sees only the workspace part, under the page's own title", async () => {
	stub("student");
	renderApp("/help");
	expect(await partHeadings()).toEqual(["Your workspace"]);
	expect(document.title).toBe("Using your workspace, Help, Portikus");
	expect(screen.queryByRole("link", { name: "For administrators" })).toBeNull();
});

test("an instructor sees the workspace and instructor parts", async () => {
	stub("instructor");
	renderApp("/help");
	expect(await partHeadings()).toEqual(["Your workspace", "For instructors"]);
});

test("a course account that teaches sees the instructor part", async () => {
	stub("student", [COURSE]);
	renderApp("/help");
	expect(
		await screen.findByRole("heading", { level: 2, name: "For instructors" }),
	).toBeDefined();
});

test("an administrator's workspace help links to the administrator help instead of holding it", async () => {
	stub("administrator");
	renderApp("/help");
	expect(await partHeadings()).toEqual(["Your workspace", "For instructors"]);
	expect(document.getElementById("admin-users")).toBeNull();
	const link = screen.getByRole("link", { name: "For administrators" });
	expect(link.getAttribute("href")).toBe("/admin/help");
});

test("/admin/help shows only the admin part, under the admin tabs, with every contents link landing", async () => {
	stub("administrator");
	renderApp("/admin/help");
	expect(await partHeadings("For administrators")).toEqual(["Running the site"]);
	expect(document.title).toBe("For administrators, Administration, Portikus");
	const tabs = screen.getByRole("navigation", { name: "Administration" });
	expect(within(tabs).queryByRole("link", { current: "page" })).toBeNull();
	expect(
		screen.getByRole("link", { name: "Using your workspace" }).getAttribute("href"),
	).toBe("/help");
	const nav = screen.getByRole("navigation", { name: "Help contents" });
	const link = within(nav).getByRole("link", {
		name: "Find a person and their workspace",
	});
	expect(link.getAttribute("href")).toBe("#admin-users");
	for (const each of within(nav).getAllByRole("link")) {
		const id = each.getAttribute("href")?.slice(1) ?? "";
		expect(document.getElementById(id)?.tagName).toMatch(/^H[23]$/);
	}
});

test("a student sent to /admin/help lands on the not-authorized page", async () => {
	stub("student");
	const { router } = renderApp("/admin/help");
	await waitFor(() => expect(router.state.location.pathname).toBe("/not-authorized"));
});

test("every admin tab's intro has an anchor on the admin help to land on", () => {
	const ids = ADMIN_HELP.topics.map((topic) => topic.id);
	for (const anchor of [
		"admin-users",
		"admin-health",
		"admin-logs",
		"admin-audit",
		"admin-network",
		"admin-backups",
		"admin-image",
		"admin-certificate",
		"admin-docker",
		"admin-settings",
	]) {
		expect(ids).toContain(anchor);
	}
	// Ids are unique, so each anchor names one place.
	expect(new Set(ids).size).toBe(ids.length);
});

test("the Course page's anchor is on the workspace help", () => {
	const ids = helpParts("instructor", false).flatMap((part) =>
		part.topics.map((topic) => topic.id),
	);
	expect(ids).toContain("instructor-course");
	expect(new Set(ids).size).toBe(ids.length);
});

// Settings links to #student-keyboard, and each student topic has its own anchor.
test("the student part has one anchored topic per section, keyboard included", () => {
	const [student] = helpParts("student", false);
	const ids = student?.topics.map((topic) => topic.id) ?? [];
	expect(ids).toEqual([
		"student-getting-started",
		"student-layout",
		"student-keep-running",
		"student-terminals",
		"student-files",
		"student-previews",
		"student-container-images",
		"student-checks",
		"student-settings",
		"student-keyboard",
		"student-trouble",
	]);
});

test("the keyboard topic lists each key beside what it does", async () => {
	stub("student");
	renderApp("/help");
	const heading = await screen.findByRole("heading", {
		level: 3,
		name: "Keyboard and screen readers",
	});
	expect(heading.id).toBe("student-keyboard");
	const section = heading.closest("section") as HTMLElement;
	const terms = Array.from(section.querySelectorAll("dl dt")).map(
		(dt) => dt.textContent,
	);
	expect(terms).toEqual([
		"Alt+Shift+Q",
		"Ctrl+M",
		"Alt+Shift+Left Arrow, Alt+Shift+Right Arrow",
		"Shift+F10",
		"F8",
	]);
	expect(section.querySelector("dt + dd")?.textContent).toMatch(/^Leave a terminal\./);
	expect(
		within(section).getByRole("heading", {
			level: 4,
			name: "What the terminal and editor cannot do",
		}),
	).toBeDefined();
	// The click ways to move tabs and panes are written down (WCAG 2.5.7).
	const descriptions = Array.from(section.querySelectorAll("dl dd")).map(
		(dd) => dd.textContent,
	);
	expect(descriptions[2]).toContain("A tab's menu also has Move left and Move right.");
	expect(descriptions[3]).toMatch(/^Open the menu of the focused tab/);
});

test("the terminals topic names the click alternatives to dragging", async () => {
	stub("student");
	renderApp("/help");
	const heading = await screen.findByRole("heading", { level: 3, name: "Terminals" });
	const section = heading.closest("section") as HTMLElement;
	for (const words of ["Move into", "Reset pane sizes", "Move left", "Move right"]) {
		expect(within(section).getByText(words, { selector: "strong" })).toBeDefined();
	}
	expect(within(section).getByText("Shift+F10", { selector: "kbd" })).toBeDefined();
});

test("signed out, Help sends you to sign in", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(401, { code: "UNAUTHORIZED", message: "no" });
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/help");
	expect(await screen.findByTestId("signin")).toBeDefined();
});

test("opened at an anchor, focus lands on that topic's heading", async () => {
	stub("student");
	window.history.replaceState(null, "", "/help#student-keyboard");
	renderApp("/help");
	const heading = await screen.findByRole("heading", {
		level: 3,
		name: "Keyboard and screen readers",
	});
	await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("opened at a part's anchor, focus lands on the part heading", async () => {
	stub("administrator");
	window.history.replaceState(null, "", "/admin/help#admin");
	renderApp("/admin/help");
	const heading = await screen.findByRole("heading", {
		level: 2,
		name: "Running the site",
	});
	await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("a malformed anchor names nothing instead of breaking the page", () => {
	expect(anchorId("#%E0%A4%A")).toBe("");
	expect(anchorId("#student%2Dkeyboard")).toBe("student-keyboard");
	expect(anchorId("")).toBe("");
});

test("the admin help explains invitations and the CSV import, right after finding a person", async () => {
	const ids = ADMIN_HELP.topics.map((topic) => topic.id);
	expect(ids.indexOf("admin-invitations")).toBe(ids.indexOf("admin-users") + 1);

	stub("administrator");
	renderApp("/admin/help");
	const heading = await screen.findByRole("heading", {
		level: 3,
		name: "Inviting people",
	});
	expect(heading.id).toBe("admin-invitations");
	const text = heading.closest("section")?.textContent ?? "";
	for (const phrase of [
		"Invite…",
		"Revoke…",
		"user principal name",
		"Import from CSV…",
		`at most ${ACCOUNT_IMPORT_MAX_ROWS} rows`,
		"Download passwords",
	]) {
		expect(text).toContain(phrase);
	}
});
