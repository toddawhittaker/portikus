import type { AdminPackagesResponse } from "@portikus/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { PackagesSection, PackagesTable, surveyDay } from "./PackagesSection.js";

afterEach(() => vi.unstubAllGlobals());

const SURVEY: AdminPackagesResponse = {
	day: "2026-09-27",
	surveyed: 9,
	packages: [
		{
			package: "python3-venv",
			workspaces: 6,
			firstSeen: "2026-09-20",
			lastSeen: "2026-09-27",
			candidate: true,
		},
		{
			package: "cowsay",
			workspaces: 0,
			firstSeen: "2026-09-21",
			lastSeen: "2026-09-22",
			candidate: false,
		},
	],
};

test("a survey day reads as a date in UTC", () => {
	expect(surveyDay("2026-09-27")).toBe("27 September 2026");
});

test("each row shows the count out of those surveyed, and marks candidates", () => {
	render(<PackagesTable survey={SURVEY} />);
	const rows = screen.getAllByTestId("packages-row");
	expect(rows).toHaveLength(2);
	const [first, second] = rows as [HTMLElement, HTMLElement];
	expect(within(first).getByRole("rowheader").textContent).toBe(
		"python3-venvBase-image candidate",
	);
	expect(first.textContent).toContain("6 of 9");
	expect(first.textContent).toContain("20 September 2026");
	expect(second.textContent).toContain("0 of 9");
	expect(second.textContent).not.toContain("candidate");
	expect(screen.getByRole("table").querySelector("caption")?.textContent).toContain(
		"9 workspaces surveyed on 27 September 2026",
	);
});

test("before the first survey it says so", () => {
	render(<PackagesTable survey={{ day: null, surveyed: 0, packages: [] }} />);
	expect(screen.getByTestId("packages-empty").textContent).toBe(
		"No workspace has been surveyed yet.",
	);
});

test("a day with nothing added says so", () => {
	render(<PackagesTable survey={{ day: "2026-09-27", surveyed: 3, packages: [] }} />);
	expect(screen.getByTestId("packages-empty").textContent).toBe(
		"No surveyed workspace had added a package on 27 September 2026.",
	);
});

test("the section loads the survey from the API", async () => {
	stubFetch((url) => {
		if (url === "/admin/packages") return json(200, SURVEY);
		throw new Error(`unexpected request: ${url}`);
	});
	renderWithQuery(<PackagesSection />);
	expect(await screen.findByTestId("packages-table")).toBeTruthy();
	expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
		"Packages students add",
	);
});

test("a failed load is announced", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "Broken." }));
	renderWithQuery(<PackagesSection />);
	expect((await screen.findByRole("alert")).textContent).toBe("Broken.");
});
