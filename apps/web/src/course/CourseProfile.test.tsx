import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { CourseProfile } from "./CourseProfile.js";

afterEach(() => vi.unstubAllGlobals());

const COURSE = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";

function course(id: string, profile: string) {
	return { id, title: `Course ${id.slice(0, 1)}`, platformName: "canvas", profile };
}

test("the instructor sees both choices with what each shows, and the current one is picked", async () => {
	stubFetch(() => json(200, [course(COURSE, "traditional"), course(OTHER, "agentic")]));
	renderWithQuery(<CourseProfile courseId={COURSE} />);

	const traditional = await screen.findByRole<HTMLInputElement>("radio", {
		name: "Traditional",
	});
	expect(traditional.checked).toBe(true);
	expect(screen.getByRole<HTMLInputElement>("radio", { name: "Agentic" }).checked).toBe(
		false,
	);
	// Each choice is described by its sentence.
	expect(traditional.getAttribute("aria-describedby")).toBeTruthy();
	const section = screen.getByRole("region", { name: "Student interface" });
	expect(section.textContent).toContain(
		"Hides the Claude Code and Codex launchers, the Docker controls and the system ports",
	);
	expect(section.textContent).toContain("never blocks anything");
	expect(section.textContent).toContain("next time they load the page");
});

test("choosing a profile saves it for this course and confirms", async () => {
	const puts: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			puts.push({ url, body });
			return json(200, { id: COURSE, profile: body.profile });
		}
		return json(200, [course(COURSE, "agentic")]);
	});
	renderWithQuery(<CourseProfile courseId={COURSE} />);

	fireEvent.click(await screen.findByRole("radio", { name: "Traditional" }));

	await waitFor(() =>
		expect(puts).toEqual([
			{ url: `/courses/${COURSE}/profile`, body: { profile: "traditional" } },
		]),
	);
	expect(await screen.findByText("Traditional saved")).toBeTruthy();
	await waitFor(() =>
		expect(
			screen.getByRole<HTMLInputElement>("radio", { name: "Traditional" }).checked,
		).toBe(true),
	);
});

test("choosing the profile already set sends nothing", async () => {
	const fetch = stubFetch(() => json(200, [course(COURSE, "agentic")]));
	renderWithQuery(<CourseProfile courseId={COURSE} />);

	fireEvent.click(await screen.findByRole("radio", { name: "Agentic" }));
	expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toEqual([]);
});

test("a refused change says why and keeps the old choice", async () => {
	stubFetch((_url, init) =>
		init?.method === "PUT"
			? json(404, { code: "NOT_FOUND", message: "You do not teach this course." })
			: json(200, [course(COURSE, "agentic")]),
	);
	renderWithQuery(<CourseProfile courseId={COURSE} />);

	fireEvent.click(await screen.findByRole("radio", { name: "Traditional" }));

	expect(await screen.findByText("Profile not saved")).toBeTruthy();
	expect(await screen.findByText("You do not teach this course.")).toBeTruthy();
	await waitFor(() =>
		expect(
			screen.getByRole<HTMLInputElement>("radio", { name: "Agentic" }).checked,
		).toBe(true),
	);
});

test("a failed load says so instead of showing choices", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "no" }));
	renderWithQuery(<CourseProfile courseId={COURSE} />);

	expect((await screen.findByTestId("course-profile-error")).textContent).toContain(
		"could not load",
	);
	expect(screen.queryByRole("radio")).toBeNull();
});
