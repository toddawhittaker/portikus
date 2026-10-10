import { describe, expect, test } from "vitest";
import { pickerPage, returnPage } from "./deep-link.js";
import type { StarterProblem } from "./starter.js";

/** The Deep Linking picker ties its error to the field it names (SPEC.md §25.8). */

const TEMPLATES = [{ name: "Starter", url: "https://example.com/starter.git" }];
const VALUES = { choice: "repository", repositoryUrl: "", projectName: "" };

function page(problem: StarterProblem | null): string {
	return pickerPage("handle-1", TEMPLATES, VALUES, problem);
}

/** The opening tag of the element whose start matches `start`. */
function tag(html: string, start: string): string {
	const at = html.indexOf(start);
	if (at < 0) throw new Error(`no ${start}`);
	return html.slice(at, html.indexOf(">", at) + 1);
}

const repository = (html: string) => tag(html, '<input type="url" id="repository"');
const project = (html: string) => tag(html, '<input type="text" id="project"');
const fieldset = (html: string) => tag(html, "<fieldset");

describe("the Deep Linking picker", () => {
	test("with no error, nothing is invalid and the title is plain", () => {
		const html = page(null);
		expect(html).toContain("<title>Choose what this link opens - Portikus</title>");
		expect(html).not.toContain("picker-error");
		expect(html).not.toContain("aria-invalid");
		expect(repository(html)).toContain('aria-describedby="repository-hint"');
		expect(project(html)).toContain('aria-describedby="project-hint"');
	});

	test.each<[StarterProblem, (html: string) => string]>([
		["repository", repository],
		["name", project],
		["source", fieldset],
		["template", fieldset],
	])(
		"a %s error marks only its field invalid and points it at the error",
		(problem, named) => {
			const html = page(problem);
			expect(html).toContain('<p class="error" id="picker-error">');
			expect(html).toContain(
				"<title>Error: Choose what this link opens - Portikus</title>",
			);
			const field = named(html);
			expect(field).toContain('aria-invalid="true"');
			expect(field).toMatch(/aria-describedby="picker-error\b/);
			expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
		},
	);

	test("an invalid field keeps its hint as well as the error", () => {
		expect(repository(page("repository"))).toContain(
			'aria-describedby="picker-error repository-hint"',
		);
		expect(project(page("name"))).toContain(
			'aria-describedby="picker-error project-hint"',
		);
	});
});

describe("the return page", () => {
	test("wraps a long unbroken project name rather than overflowing", () => {
		const html = returnPage("https://lms.example.edu/return", "jwt", "A".repeat(200));
		expect(html).toMatch(/p \{[^}]*overflow-wrap: anywhere;/);
		expect(html).toContain("<title>Link ready - Portikus</title>");
	});
});
