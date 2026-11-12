import { expect, test } from "vitest";
import { courseCode } from "./CourseHead.js";

test("a course's code is the short part before the colon", () => {
	expect(courseCode("CS 1210: Programming for the Web")).toBe("CS 1210");
	expect(courseCode("CS 101 Intro to Programming")).toBeNull();
	expect(courseCode("A very long course name that is not a code: Part two")).toBeNull();
	expect(courseCode(": Untitled")).toBeNull();
});
