import { screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { helpParts } from "./HelpPage.js";

afterEach(() => vi.unstubAllGlobals());

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
		"admin-settings",
		"instructor-course",
	]) {
		expect(ids).toContain(anchor);
	}
	// Ids are unique, so each anchor names one place.
	expect(new Set(ids).size).toBe(ids.length);
});

test("signed out, Help sends you to sign in", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(401, { code: "UNAUTHORIZED", message: "no" });
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/help");
	expect(await screen.findByTestId("signin")).toBeDefined();
});
