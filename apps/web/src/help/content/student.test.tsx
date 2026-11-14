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
		"Tab indents an item and Shift+Tab moves a nested item back out",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the chat topic says a quick second paste puts long text in the box", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	expect(text).toContain("paste it again straight away.");
});

test("the chat topic covers the menus, shell commands, deny reasons, read aloud and colours", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	for (const phrase of [
		"to see Claude's commands",
		"to pick a project file",
		"Start a message with ! to run it as a shell command",
		"Tell Claude what to do instead",
		"Yes, and accept edits",
		"Yes, and ask before edits",
		"language label and syntax colours",
		"Read replies aloud",
		"the text of the reply is sent to the browser's maker",
		"Portikus never receives or keeps the text",
		"Cache cold",
		"choose one to open it, or its changes in a Git project",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the agent status topic describes the left-pane agent rows and the seven-day usage", () => {
	const text = topicText("student-agent-status").replace(/\s+/g, " ");
	expect(text).toContain("its subagents are listed");
	expect(text).toContain("seven-day plan limit");
});

test("the agent status topic no longer says Codex has no subagents, and says what its rows and questions show", () => {
	const text = topicText("student-agent-status").replace(/\s+/g, " ");
	expect(text).not.toContain("Codex shows no subagents");
	expect(text).toContain("A Codex subagent's row shows its type but no description");
	expect(text).toContain("When Codex asks a question in a terminal");
	expect(text).toContain("the browser has no card for it");
});

test("the Codex topic covers pickers, the five modes, the plan card, questions and secrets", () => {
	const text = topicText("student-codex-chat").replace(/\s+/g, " ");
	for (const phrase of [
		"Codex (GUI) is a chat tab",
		"There is no Version",
		"Ask asks before Codex runs any command",
		"Read only",
		"Plan lets it look around",
		"Auto lets it work in the project on its own",
		"Full access runs anything without asking",
		"a new chat never starts in it",
		"Yes, in Auto",
		"Yes, and ask first",
		"No, keep planning",
		"Allow once, Deny and, when Codex offers it, Allow for this chat",
		"Allow for this chat",
		'There is no "Always allow"',
		"the box hides what you type",
		"never shown in the conversation",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the Codex topic covers commands, $ skills, subagents, the meter and signing in", () => {
	const text = topicText("student-codex-chat").replace(/\s+/g, " ");
	for (const phrase of [
		"/review",
		"/mcp run in the chat",
		"/resume",
		"/logout, are greyed out",
		"Type $ at the start of a message to see only your skills",
		"Used skill",
		"Codex gives a subagent no description, so its row shows only its type",
		"so there is no countdown, only the tokens used",
		"codex login --device-auth",
		"Do not run a Codex (GUI) tab and a Codex (TUI) terminal on the same Codex session",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the Codex topic explains switching agents and its warning", () => {
	const text = topicText("student-codex-chat").replace(/\s+/g, " ");
	for (const phrase of [
		"switch agents in the middle of a chat",
		"the new agent starts fresh with this conversation as its context",
		"the prompt cache is lost",
		"each tool call reduced to a short summary",
		"the oldest turns are left out, and the warning says so",
		"A chat with nothing in it switches with no warning",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the Codex topic lists what Codex cannot do here", () => {
	const text = topicText("student-codex-chat").replace(/\s+/g, " ");
	expect(text).toContain("What Codex cannot do here");
	expect(text).toContain("there is no question card in the browser");
	expect(text).toContain(
		"cannot be revoked from Portikus's list; a new chat clears it",
	);
	expect(text).toContain("The memory meter counts tokens only");
	expect(text).toContain("wait for trust in a terminal");
});

test("the tools topic covers skills, MCP servers, plugins and project trust for both agents", () => {
	const text = topicText("student-agent-tools").replace(/\s+/g, " ");
	for (const phrase of [
		"Claude Code (GUI) chat and a Codex (GUI) chat alike",
		"Claude Code's as /name and Codex's as $name",
		"connected, starting, failed, needs you to sign in, or turned off",
		"The list is read-only",
		"claude mcp or codex mcp",
		"Allow server to run tool?",
		"use a terminal tab for it",
		"Install and manage plugins in a terminal",
		"/plugin in Claude Code or /plugins in Codex",
		"start only after you have trusted the project in a terminal",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the Claude topic points to the tools and to switching agents", () => {
	const text = topicText("student-claude-chat").replace(/\s+/g, " ");
	expect(text).toContain("Skills, MCP servers and plugins");
	expect(text).toContain("choose Codex in the Agent menu");
});

test("the live-help terms in Help name Codex credentials beside Git, Claude and SSH", () => {
	expect(topicText("student-live-help")).toContain(
		"Git, Claude, Codex and SSH credentials",
	);
});

test("the keyboard topic lists the completion and hover keys", () => {
	const text = topicText("student-keyboard");
	expect(text).toContain("Ctrl+Space");
	expect(text).toContain("Ctrl+K, then Ctrl+I");
});

test("the topics that name Claude Code and Codex say a course may hide them", () => {
	expect(topicText("student-getting-started")).toContain(
		"it hides the Claude Code and Codex choices",
	);
	expect(topicText("student-layout")).toContain(
		"Your course may hide Claude Code and Codex",
	);
});

test("getting started names the six New tab choices", () => {
	const text = topicText("student-getting-started");
	expect(text).toContain("six choices");
	for (const choice of [
		"Terminal",
		"Claude Code (TUI)",
		"Codex (TUI)",
		"Claude Code (GUI)",
		"Codex (GUI)",
		"Preview",
	]) {
		expect(text).toContain(choice);
	}
});

test("the layout topic names both Codex launchers", () => {
	expect(topicText("student-layout")).toContain(
		"Codex (GUI), Codex (TUI) or a preview",
	);
});

test("the Claude topic describes the decision line and the terminal question card", () => {
	const text = topicText("student-claude-chat");
	expect(text).toContain("Allowed for this chat");
	expect(text).toContain("Plan approved");
	expect(text).toContain("Answer in the terminal");
});

test("the phone topic names both drawer buttons and how a drawer closes", () => {
	const text = topicText("student-phone");
	expect(text).toContain("Projects");
	expect(text).toContain("Files");
	expect(text).toContain("Escape");
});

test("the chat topic names the five permission modes", () => {
	const text = topicText("student-claude-chat");
	for (const mode of ["Ask", "Accept edits", "Plan", "Auto", "Bypass permissions"]) {
		expect(text).toContain(mode);
	}
});

test("the chat topic covers versions, titles, subagents, zoom and the ended tab's choices", () => {
	const text = topicText("student-claude-chat");
	for (const phrase of [
		"34.2k / 1M",
		"Version",
		"Latest",
		"/rename",
		"read-only",
		"Show its conversation",
		"closes it too",
		"switch at the top of the Chat options panel",
		"send a message first",
		"New terminal here",
		"Ctrl+Shift+=",
	]) {
		expect(text).toContain(phrase);
	}
});

test("the terminals topic says a terminal leaves Ctrl+= and Ctrl+- to the shell", () => {
	expect(topicText("student-terminals")).toContain(
		"leaves Ctrl+= and Ctrl+- to the shell",
	);
});

test("the files topic describes Git letters with U for new files", () => {
	const text = topicText("student-files");
	expect(text).toContain("U new and not yet tracked");
	expect(text).toContain("A dot beside a folder");
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
