import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { CoursesGroup } from "./CoursesGroup.js";

afterEach(() => vi.unstubAllGlobals());

const CS101 = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101 Intro to Programming",
	platformName: "canvas",
	profile: "agentic",
};
const CS240 = {
	id: "66666666-6666-4666-8666-666666666666",
	title: "CS 240 Data Structures",
	platformName: "moodle",
	profile: "traditional",
};

test("each course is a row with its platform and a profile choice that names the course", async () => {
	stubFetch(() => json(200, [CS101, CS240]));
	renderWithQuery(<CoursesGroup />);

	const rows = await screen.findAllByTestId("courses-row");
	expect(rows).toHaveLength(2);
	expect(within(rows[0] as HTMLElement).getByText("canvas")).toBeTruthy();
	const first = screen.getByRole("combobox", { name: `Profile for ${CS101.title}` });
	expect(first.textContent).toContain("Agentic");
	const second = screen.getByRole("combobox", { name: `Profile for ${CS240.title}` });
	expect(second.textContent).toContain("Traditional");
	// The group says what Traditional hides and that it never blocks.
	const group = screen.getByRole("region", { name: "Courses" });
	expect(group.textContent).toContain("never blocks anything");
});

test("choosing a profile sends it for that course and says so", async () => {
	const puts: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			puts.push({ url, body });
			return json(200, { id: CS101.id, profile: body.profile });
		}
		return json(200, [CS101, CS240]);
	});
	renderWithQuery(<CoursesGroup />);

	fireEvent.click(
		await screen.findByRole("combobox", { name: `Profile for ${CS101.title}` }),
	);
	fireEvent.click(await screen.findByRole("option", { name: "Traditional" }));

	await waitFor(() =>
		expect(puts).toEqual([
			{
				url: `/admin/courses/${CS101.id}/profile`,
				body: { profile: "traditional" },
			},
		]),
	);
	expect(await screen.findByText(`${CS101.title} is now Traditional`)).toBeTruthy();
	await waitFor(() =>
		expect(
			screen.getByRole("combobox", { name: `Profile for ${CS101.title}` }).textContent,
		).toContain("Traditional"),
	);
});

test("the choice stays focusable and is marked unavailable while it saves", async () => {
	let finish: (() => void) | undefined;
	stubFetch(async (_url, init) => {
		if (init?.method === "PUT") {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return json(200, { id: CS101.id, profile: "traditional" });
		}
		return json(200, [CS101]);
	});
	renderWithQuery(<CoursesGroup />);

	const select = await screen.findByRole("combobox", {
		name: `Profile for ${CS101.title}`,
	});
	select.focus();
	fireEvent.click(select);
	fireEvent.click(await screen.findByRole("option", { name: "Traditional" }));

	await waitFor(() => expect(select.getAttribute("aria-disabled")).toBe("true"));
	expect((select as HTMLButtonElement).disabled).toBe(false);
	await waitFor(() => expect(document.activeElement).toBe(select));
	finish?.();
	await waitFor(() => expect(select.getAttribute("aria-disabled")).toBeNull());
	expect(document.activeElement).toBe(select);
});

test("a refused change says why and keeps the old profile", async () => {
	stubFetch((_url, init) =>
		init?.method === "PUT"
			? json(500, { code: "INTERNAL", message: "The profile could not be saved." })
			: json(200, [CS101]),
	);
	renderWithQuery(<CoursesGroup />);

	fireEvent.click(
		await screen.findByRole("combobox", { name: `Profile for ${CS101.title}` }),
	);
	fireEvent.click(await screen.findByRole("option", { name: "Traditional" }));

	expect(await screen.findByText("Profile not saved")).toBeTruthy();
	expect(await screen.findByText("The profile could not be saved.")).toBeTruthy();
	expect(
		screen.getByRole("combobox", { name: `Profile for ${CS101.title}` }).textContent,
	).toContain("Agentic");
});

test("with no courses the group says how one appears", async () => {
	stubFetch(() => json(200, []));
	renderWithQuery(<CoursesGroup />);

	expect((await screen.findByTestId("courses-empty")).textContent).toContain(
		"after someone opens Portikus from it",
	);
	expect(screen.queryByTestId("courses-list")).toBeNull();
});

test("a failed load shows the server's message", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "Courses are down." }));
	renderWithQuery(<CoursesGroup />);

	expect((await screen.findByTestId("courses-error")).textContent).toBe(
		"Courses are down.",
	);
});
