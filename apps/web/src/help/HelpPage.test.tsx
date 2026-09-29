import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { anchorId, helpParts } from "./HelpPage.js";

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

async function partHeadings(): Promise<string[]> {
	await screen.findByRole("heading", { level: 1, name: "Help" });
	return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

test("a student sees only the workspace part", async () => {
	stub("student");
	renderApp("/help");
	expect(await partHeadings()).toEqual(["Using your workspace"]);
	expect(document.title).toBe("Help, Portikus");
});

test("an instructor sees the workspace and instructor parts", async () => {
	stub("instructor");
	renderApp("/help");
	expect(await partHeadings()).toEqual(["Using your workspace", "For instructors"]);
});

test("a course account that teaches sees the instructor part", async () => {
	stub("student", [COURSE]);
	renderApp("/help");
	expect(
		await screen.findByRole("heading", { level: 2, name: "For instructors" }),
	).toBeDefined();
});

test("an administrator sees every part, with the contents linking to each topic", async () => {
	stub("administrator");
	renderApp("/help");
	expect(await partHeadings()).toEqual([
		"Using your workspace",
		"For administrators",
		"For instructors",
	]);
	const nav = screen.getByRole("navigation", { name: "Help contents" });
	const link = within(nav).getByRole("link", {
		name: "Find a person and their workspace",
	});
	expect(link.getAttribute("href")).toBe("#admin-users");
	// Every contents link lands on a heading on the page.
	for (const each of within(nav).getAllByRole("link")) {
		const id = each.getAttribute("href")?.slice(1) ?? "";
		expect(document.getElementById(id)?.tagName).toMatch(/^H[23]$/);
	}
});

test("every admin tab's intro has a Help anchor to land on", () => {
	const ids = helpParts("administrator", false).flatMap((part) =>
		part.topics.map((topic) => topic.id),
	);
	for (const anchor of [
		"admin-users",
		"admin-health",
		"admin-logs",
		"admin-audit",
		"admin-network",
		"admin-backups",
		"admin-image",
		"admin-settings",
		"instructor-course",
	]) {
		expect(ids).toContain(anchor);
	}
	// Ids are unique, so each anchor names one place.
	expect(new Set(ids).size).toBe(ids.length);
});

// Epic 25: Settings links to #student-keyboard, and each student topic has its own anchor.
test("the student part has one anchored topic per section, keyboard included", () => {
	const [student] = helpParts("student", false);
	const ids = student?.topics.map((topic) => topic.id) ?? [];
	expect(ids).toEqual([
		"student-getting-started",
		"student-layout",
		"student-terminals",
		"student-files",
		"student-previews",
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
		"Alt+F1",
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
	window.history.replaceState(null, "", "/help#admin");
	renderApp("/help");
	const heading = await screen.findByRole("heading", {
		level: 2,
		name: "For administrators",
	});
	await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("a malformed anchor names nothing instead of breaking the page", () => {
	expect(anchorId("#%E0%A4%A")).toBe("");
	expect(anchorId("#student%2Dkeyboard")).toBe("student-keyboard");
	expect(anchorId("")).toBe("");
});
