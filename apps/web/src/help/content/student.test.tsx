import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { STUDENT_HELP } from "./student.js";

afterEach(cleanup);

function topicText(id: string): string {
	const topic = STUDENT_HELP.topics.find((item) => item.id === id);
	if (!topic) throw new Error(`no topic ${id}`);
	return render(<div>{topic.body}</div>).container.textContent ?? "";
}

test("student help explains code help: features, Problems, the size limit and every bar state", () => {
	const text = topicText("student-code-help");
	for (const feature of [
		"Completion",
		"Hover",
		"Go to definition",
		"Rename",
		"Format",
		"Errors and warnings",
	]) {
		expect(text).toContain(feature);
	}
	expect(text).toContain("Problems");
	expect(text).toContain("covers the whole project");
	expect(text).toContain("Code help is off for files over 512 KB");
	for (const state of [
		"Code help starting",
		"Code help ready",
		"Code help unavailable",
		"Code help stopped",
		"Code help is on in another window",
	]) {
		expect(text).toContain(state);
	}
	expect(text).toContain("Restart");
	expect(text).toContain("Use here");
	expect(text).toContain("Alt+F8");
	expect(text).toContain("Shift+Alt+F8");
});

test("the keyboard topic lists the problem keys beside F8, which still goes to notifications", () => {
	const text = topicText("student-keyboard");
	expect(text).toContain("Alt+F8, Shift+Alt+F8");
	expect(text).toContain("Move to notifications");
});

test("the layout topic names the Problems tab and says when it appears", () => {
	const text = topicText("student-layout");
	expect(text).toContain("Problems");
	expect(text).toContain("appears only while code help is on");
});

test("topic ids stay unique, because each is a link target", () => {
	const ids = STUDENT_HELP.topics.map((topic) => topic.id);
	expect(new Set(ids).size).toBe(ids.length);
});
