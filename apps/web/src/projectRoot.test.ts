import { expect, test } from "vitest";
import { projectRoot } from "./projectRoot";

test("a project lives under the student's projects folder, by slug", () => {
	expect(projectRoot("todo-api")).toBe("/home/student/projects/todo-api");
});
