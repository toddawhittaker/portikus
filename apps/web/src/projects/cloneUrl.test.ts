import { expect, test } from "vitest";
import { cloneUrlForRequest, projectNameFromCloneUrl } from "./cloneUrl.js";

test("the name is the last path segment with .git removed", () => {
	expect(projectNameFromCloneUrl("https://github.com/user/todo-api.git")).toBe(
		"todo-api",
	);
	expect(projectNameFromCloneUrl("https://github.com/user/todo-api")).toBe("todo-api");
	expect(projectNameFromCloneUrl("https://gitlab.com/group/sub/thing.git/")).toBe(
		"thing",
	);
	expect(projectNameFromCloneUrl("  https://codeberg.org/u/Repo.GIT  ")).toBe("Repo");
});

test("ssh and user@host:path urls give the same name", () => {
	expect(projectNameFromCloneUrl("git@github.com:user/todo-api.git")).toBe("todo-api");
	expect(projectNameFromCloneUrl("ssh://git@example.com:22/srv/git/todo-api.git")).toBe(
		"todo-api",
	);
});

test("an empty or unusable url gives an empty name", () => {
	expect(projectNameFromCloneUrl("")).toBe("");
	expect(projectNameFromCloneUrl("   ")).toBe("");
	expect(projectNameFromCloneUrl("https://github.com/")).toBe("github.com");
});

test("https urls on the known hosts get the missing .git suffix", () => {
	expect(cloneUrlForRequest("https://github.com/user/todo-api")).toBe(
		"https://github.com/user/todo-api.git",
	);
	expect(cloneUrlForRequest("https://gitlab.com/user/todo-api/")).toBe(
		"https://gitlab.com/user/todo-api.git",
	);
	expect(cloneUrlForRequest("https://bitbucket.org/user/todo-api")).toBe(
		"https://bitbucket.org/user/todo-api.git",
	);
	expect(cloneUrlForRequest("https://codeberg.org/user/todo-api")).toBe(
		"https://codeberg.org/user/todo-api.git",
	);
});

test("a url that already ends in .git is left alone", () => {
	expect(cloneUrlForRequest("https://github.com/user/todo-api.git")).toBe(
		"https://github.com/user/todo-api.git",
	);
});

test("other hosts and non-https urls are sent exactly as typed", () => {
	expect(cloneUrlForRequest("https://dev.azure.com/org/project/_git/repo")).toBe(
		"https://dev.azure.com/org/project/_git/repo",
	);
	expect(cloneUrlForRequest("http://github.com/user/todo-api")).toBe(
		"http://github.com/user/todo-api",
	);
	expect(cloneUrlForRequest("git@github.com:user/todo-api.git")).toBe(
		"git@github.com:user/todo-api.git",
	);
	expect(cloneUrlForRequest("  https://example.com/repo  ")).toBe(
		"https://example.com/repo",
	);
});

test("a github url that is not owner/repo is left alone", () => {
	expect(cloneUrlForRequest("https://github.com/user")).toBe("https://github.com/user");
	expect(cloneUrlForRequest("https://github.com/o/r/tree/main")).toBe(
		"https://github.com/o/r/tree/main",
	);
});
