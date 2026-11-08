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

test("the code-help topic says the administrator chooses languages, and what a turned-off one gets", () => {
	const text = topicText("student-code-help");
	expect(text).toContain("chooses which languages have code help");
	expect(text).toContain(
		"Code help is off for a language your administrator has turned off",
	);
	expect(text).toContain("plain editor");
	expect(text).toContain("gone only when every language is off");
	expect(text).not.toContain("for the whole site");
});

test("the code-help topic gives the keyboard routes to completion and hover, and says where the bar is", () => {
	const text = topicText("student-code-help");
	expect(text).toContain("Ctrl+Space");
	expect(text).toContain("Ctrl+K");
	expect(text).toContain("Ctrl+I");
	expect(text).toContain("The bar under the file");
	expect(text).not.toContain("above the file");
});

test("the chat topic says a message sent mid-turn may be treated with caution and that Stop then send works", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	expect(text).toContain("Some models treat a message sent this way with caution");
	expect(text).toContain("stop Claude, then send it again; that always works");
});

test("the chat topic lists the message box's typing shortcuts", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	for (const phrase of [
		"three stars both",
		"two tildes strike through",
		'"[ ]" or "[x]" a task',
		'">" a quote',
		'one to three "#" a heading',
		"three dashes a separator line",
		"[text](address)",
		"Tab indents an item and Shift+Tab moves it back out",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the chat topic says a quick second paste puts long text in the box", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	expect(text).toContain("paste it again straight away, within a second");
});

test("the keyboard topic lists the completion and hover keys", () => {
	const text = topicText("student-keyboard");
	expect(text).toContain("Ctrl+Space");
	expect(text).toContain("Ctrl+K, then Ctrl+I");
});

test("the topics that name Claude Code and Codex say a course may hide them", () => {
	expect(topicText("student-getting-started")).toContain(
		"Your course may hide Claude Code and Codex",
	);
	expect(topicText("student-layout")).toContain(
		"Your course may hide Claude Code and Codex",
	);
});

test("the chat topic explains Resume and not running a GUI and a TUI on one session", () => {
	const text = topicText("student-claude-chat");
	expect(text).toContain("Resume chat");
	expect(text).toContain(
		"Do not run a GUI tab and a TUI terminal on the same Claude session",
	);
});

test("the keyboard topic lists the problem keys beside F8, which still goes to notifications", () => {
	const text = topicText("student-keyboard");
	expect(text).toContain("Alt+F8, Shift+Alt+F8");
	expect(text).toContain("Move to notifications");
});

test("the layout topic names the Problems tab and says when it appears", () => {
	const text = topicText("student-layout");
	expect(text).toContain("Problems");
	expect(text).toContain(
		"appears only while code help is on for at least one language",
	);
});

test("the agent status topic covers the marks, alerts, desktop notifications, usage and the Esc gap", () => {
	const text = topicText("student-agent-status");
	for (const phrase of [
		"needs your input",
		"These messages are not kept in Notifications",
		"moves to the newest one, even from inside a terminal",
		"does not ask your browser",
		"Allow in this browser",
		"site settings",
		"85 percent",
		"tokens and cost for today",
		"its tab keeps showing",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the terminals and files topics describe dropping a file and Copy path", () => {
	expect(topicText("student-terminals")).toContain(
		"content dragged from other pages is ignored",
	);
	const files = topicText("student-files");
	expect(files).toContain("Copy path");
	expect(files).toContain("separated by spaces");
});

test("topic ids stay unique, because each is a link target", () => {
	const ids = STUDENT_HELP.topics.map((topic) => topic.id);
	expect(new Set(ids).size).toBe(ids.length);
});
