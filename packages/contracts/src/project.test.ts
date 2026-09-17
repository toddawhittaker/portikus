import { expect, test } from "vitest";
import {
	CloneUrl,
	CreateProjectRequest,
	DuplicateProjectRequest,
	Project,
	ProjectLayout,
	ProjectList,
	ProjectSlug,
	ProjectTemplate,
	ProjectTemplateList,
	parseProjectTemplates,
	SplitNode,
	slugify,
	UpdateProjectRequest,
} from "./index.js";

const sampleProject = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	workspaceId: "550e8400-e29b-41d4-a716-446655440111",
	slug: "intro-to-java",
	name: "Intro to Java",
	path: "/home/student/projects/intro-to-java",
	state: "active",
	source: "new",
	isGitRepo: true,
	missing: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	archivedAt: null,
};

test("Project round-trips a complete record", () => {
	expect(Project.parse(sampleProject)).toEqual(sampleProject);
});

test("Project accepts unknown git and missing state", () => {
	const unknown = { ...sampleProject, isGitRepo: null, missing: null };
	expect(Project.parse(unknown)).toEqual(unknown);
});

test("Project rejects a bad slug, state or source", () => {
	expect(Project.safeParse({ ...sampleProject, slug: "Bad Slug" }).success).toBe(false);
	expect(Project.safeParse({ ...sampleProject, state: "deleted" }).success).toBe(false);
	expect(Project.safeParse({ ...sampleProject, source: "magic" }).success).toBe(false);
});

test("ProjectList wraps projects", () => {
	expect(ProjectList.parse({ projects: [sampleProject] }).projects).toHaveLength(1);
});

test("ProjectSlug enforces the pattern", () => {
	expect(ProjectSlug.safeParse("a").success).toBe(true);
	expect(ProjectSlug.safeParse("my-project-1").success).toBe(true);
	expect(ProjectSlug.safeParse("-leading").success).toBe(false);
	expect(ProjectSlug.safeParse("Upper").success).toBe(false);
	expect(ProjectSlug.safeParse("has_underscore").success).toBe(false);
	expect(ProjectSlug.safeParse("").success).toBe(false);
	expect(ProjectSlug.safeParse("a".repeat(63)).success).toBe(true);
	expect(ProjectSlug.safeParse("a".repeat(64)).success).toBe(false);
});

test("slugify lowercases and joins runs of other characters", () => {
	expect(slugify("Intro to Java")).toBe("intro-to-java");
	expect(slugify("CS  101 -- Lab #3!")).toBe("cs-101-lab-3");
	expect(slugify("  spaced  ")).toBe("spaced");
});

test("slugify truncates to 63 characters without a trailing hyphen", () => {
	const slug = slugify(`${"a".repeat(62)} b`);
	expect(slug).toBe("a".repeat(62));
	expect(slugify("a".repeat(80))).toBe("a".repeat(63));
});

test("slugify returns an empty string when nothing is usable", () => {
	expect(slugify("!!!")).toBe("");
	expect(slugify("")).toBe("");
});

test("every slugify result that is not empty is a valid slug", () => {
	for (const name of ["Intro to Java", "CS  101 -- Lab #3!", "  spaced  ", "9 lives"]) {
		expect(ProjectSlug.safeParse(slugify(name)).success).toBe(true);
	}
});

test("CloneUrl accepts the allowed transports", () => {
	for (const url of [
		"https://github.com/example/repo.git",
		"http://git.internal/example/repo.git",
		"ssh://git@github.com/example/repo.git",
		"git@github.com:example/repo.git",
	]) {
		expect(CloneUrl.safeParse(url).success).toBe(true);
	}
});

test("CloneUrl rejects local and command transports", () => {
	for (const url of [
		"file:///etc/passwd",
		"ext::sh -c whoami",
		"/home/student/projects/demo",
		"git://github.com/example/repo.git",
	]) {
		expect(CloneUrl.safeParse(url).success).toBe(false);
	}
});

test("CloneUrl rejects an option-looking argument", () => {
	expect(CloneUrl.safeParse("--upload-pack=whoami").success).toBe(false);
	expect(CloneUrl.safeParse("-https://github.com/example/repo").success).toBe(false);
});

test("CloneUrl rejects whitespace and control characters", () => {
	expect(CloneUrl.safeParse("https://host/a b").success).toBe(false);
	expect(CloneUrl.safeParse("https://host/a\nb").success).toBe(false);
	const nul = String.fromCharCode(0);
	expect(CloneUrl.safeParse(`https://host/a${nul}b`).success).toBe(false);
	const del = String.fromCharCode(127);
	expect(CloneUrl.safeParse(`https://host/a${del}b`).success).toBe(false);
	expect(CloneUrl.safeParse("").success).toBe(false);
});

test("ProjectTemplate and its list validate the url", () => {
	const template = { name: "Java starter", url: "https://git.example/java.git" };
	expect(ProjectTemplate.parse(template)).toEqual(template);
	expect(ProjectTemplateList.parse({ templates: [template] }).templates).toHaveLength(
		1,
	);
	expect(ProjectTemplate.safeParse({ name: "bad", url: "file:///tmp/x" }).success).toBe(
		false,
	);
});

test("parseProjectTemplates reads name=url pairs", () => {
	expect(
		parseProjectTemplates(
			"Java starter=https://git.example/java.git, Python=ssh://git@git.example/py.git",
		),
	).toEqual([
		{ name: "Java starter", url: "https://git.example/java.git" },
		{ name: "Python", url: "ssh://git@git.example/py.git" },
	]);
});

test("parseProjectTemplates returns nothing for an empty value", () => {
	expect(parseProjectTemplates("")).toEqual([]);
	expect(parseProjectTemplates("  ,  ")).toEqual([]);
});

test("parseProjectTemplates throws on a malformed entry", () => {
	expect(() => parseProjectTemplates("no-equals-sign")).toThrow();
	expect(() => parseProjectTemplates("=https://git.example/x.git")).toThrow();
	expect(() => parseProjectTemplates("bad=file:///tmp/x")).toThrow();
});

test("CreateProjectRequest defaults gitInit to true and rejects extras", () => {
	expect(CreateProjectRequest.parse({ name: "Demo", source: "new" })).toEqual({
		name: "Demo",
		source: "new",
		gitInit: true,
	});
	expect(
		CreateProjectRequest.safeParse({ name: "Demo", source: "new", slug: "demo" })
			.success,
	).toBe(false);
});

test("CreateProjectRequest requires a url for clone and a template for template", () => {
	expect(
		CreateProjectRequest.safeParse({ name: "Demo", source: "clone" }).success,
	).toBe(false);
	expect(
		CreateProjectRequest.safeParse({
			name: "Demo",
			source: "clone",
			url: "https://git.example/x.git",
		}).success,
	).toBe(true);
	expect(
		CreateProjectRequest.safeParse({ name: "Demo", source: "template" }).success,
	).toBe(false);
	expect(
		CreateProjectRequest.safeParse({
			name: "Demo",
			source: "template",
			template: "Java starter",
		}).success,
	).toBe(true);
});

test("CreateProjectRequest forbids a url or template for a new project", () => {
	expect(
		CreateProjectRequest.safeParse({
			name: "Demo",
			source: "new",
			url: "https://git.example/x.git",
		}).success,
	).toBe(false);
	expect(
		CreateProjectRequest.safeParse({
			name: "Demo",
			source: "new",
			template: "Java starter",
		}).success,
	).toBe(false);
});

test("UpdateProjectRequest needs at least one field", () => {
	expect(UpdateProjectRequest.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
	expect(UpdateProjectRequest.parse({ state: "archived" })).toEqual({
		state: "archived",
	});
	expect(UpdateProjectRequest.safeParse({}).success).toBe(false);
	expect(UpdateProjectRequest.safeParse({ slug: "x" }).success).toBe(false);
});

test("DuplicateProjectRequest requires a name and rejects extras", () => {
	expect(DuplicateProjectRequest.parse({ name: "Copy" })).toEqual({ name: "Copy" });
	expect(DuplicateProjectRequest.safeParse({}).success).toBe(false);
	expect(
		DuplicateProjectRequest.safeParse({ name: "Copy", slug: "copy" }).success,
	).toBe(false);
});

const leaf = (id: string) => ({ type: "leaf" as const, terminalId: id });
const terminalA = "550e8400-e29b-41d4-a716-446655440001";
const terminalB = "550e8400-e29b-41d4-a716-446655440002";

test("SplitNode accepts a leaf and a nested split", () => {
	expect(SplitNode.parse(leaf(terminalA))).toEqual(leaf(terminalA));

	const nested = {
		type: "split",
		direction: "row",
		sizes: [50, 50],
		children: [
			leaf(terminalA),
			{
				type: "split",
				direction: "column",
				sizes: [30, 70],
				children: [leaf(terminalB), leaf(terminalA)],
			},
		],
	};
	expect(SplitNode.parse(nested)).toEqual(nested);
});

test("SplitNode rejects a leaf without a terminal id and a one-child split", () => {
	expect(SplitNode.safeParse({ type: "leaf" }).success).toBe(false);
	expect(SplitNode.safeParse({ type: "leaf", terminalId: "not-a-uuid" }).success).toBe(
		false,
	);
	expect(
		SplitNode.safeParse({
			type: "split",
			direction: "row",
			sizes: [100],
			children: [leaf(terminalA)],
		}).success,
	).toBe(false);
});

test("SplitNode requires one size per child", () => {
	expect(
		SplitNode.safeParse({
			type: "split",
			direction: "row",
			sizes: [100],
			children: [leaf(terminalA), leaf(terminalB)],
		}).success,
	).toBe(false);
});

test("ProjectLayout holds tabs of split trees", () => {
	const layout = {
		tabs: [
			{ id: "tab-1", root: leaf(terminalA) },
			{
				id: "tab-2",
				root: {
					type: "split",
					direction: "column",
					sizes: [50, 50],
					children: [leaf(terminalA), leaf(terminalB)],
				},
			},
		],
	};
	expect(ProjectLayout.parse(layout)).toEqual(layout);
	expect(ProjectLayout.parse({ tabs: [] })).toEqual({ tabs: [] });
	expect(
		ProjectLayout.safeParse({ tabs: [{ id: "", root: leaf(terminalA) }] }).success,
	).toBe(false);
});
