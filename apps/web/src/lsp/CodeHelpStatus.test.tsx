import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeHelpStatus } from "./CodeHelpStatus.js";
import { type ServerStatus, useCodeHelpStore } from "./store.js";

afterEach(() => {
	cleanup();
	useCodeHelpStore.setState({ viewers: {} });
});

function show(status: ServerStatus, tooLarge = false, shown = true) {
	render(
		<CodeHelpStatus
			path="a.py"
			announceKey="p1:python"
			shown={shown}
			status={status}
			tooLarge={tooLarge}
			onRestart={vi.fn()}
		/>,
	);
	return screen.getByRole("status");
}

test("starting and ready are shown but not announced", () => {
	for (const state of ["starting", "ready"] as const) {
		const live = show({ state });
		expect(live.textContent).toBe("");
		expect(screen.getByTestId("editor-code-help-a.py").textContent).toMatch(
			/Code help/,
		);
		cleanup();
	}
});

test("states that ask for action, and too large, are announced", () => {
	expect(show({ state: "unavailable" }).textContent).toBe("Code help unavailable");
	cleanup();
	expect(show({ state: "crashed" }).textContent).toBe("Code help stopped");
	cleanup();
	expect(show({ state: "replaced" }).textContent).toBe(
		"Code help is on in another window",
	);
	cleanup();
	expect(show({ state: "ready" }, true).textContent).toMatch(/512 KB/);
});

test("Restart is named for what it restarts", () => {
	show({ state: "crashed" });
	expect(screen.getByRole("button", { name: "Restart code help" })).toBeTruthy();
});

function bar(path: string, status: ServerStatus, tooLarge = false, shown = true) {
	return (
		<CodeHelpStatus
			key={path}
			path={path}
			announceKey="p1:python"
			shown={shown}
			status={status}
			tooLarge={tooLarge}
			onRestart={vi.fn()}
		/>
	);
}

const announced = (path: string) =>
	within(screen.getByTestId(`editor-code-help-${path}`)).getByRole("status")
		.textContent;

test("two editors side by side announce a crash once, and both show it", () => {
	const crashed: ServerStatus = { state: "crashed" };
	render(
		<>
			{bar("a.py", crashed)}
			{bar("b.py", crashed)}
		</>,
	);
	expect(announced("a.py")).toBe("Code help stopped");
	expect(announced("b.py")).toBe("");
	expect(screen.getByTestId("editor-code-help-b.py").textContent).toBe(
		"Code help stopped",
	);
	expect(screen.getAllByRole("button", { name: "Restart code help" })).toHaveLength(2);
});

test("a replaced state is announced once as well", () => {
	const replaced: ServerStatus = { state: "replaced" };
	render(
		<>
			{bar("a.py", replaced)}
			{bar("b.py", replaced)}
		</>,
	);
	expect(announced("a.py")).toBe("Code help is on in another window");
	expect(announced("b.py")).toBe("");
});

test("when the announcing editor closes, the other one announces", () => {
	const crashed: ServerStatus = { state: "crashed" };
	const { rerender } = render(
		<>
			{bar("a.py", crashed)}
			{bar("b.py", crashed)}
		</>,
	);
	rerender(bar("b.py", crashed));
	expect(announced("b.py")).toBe("Code help stopped");
});

test("editors on different servers each announce their own", () => {
	render(
		<>
			{bar("a.py", { state: "crashed" })}
			<CodeHelpStatus
				path="a.ts"
				announceKey="p1:typescript"
				shown
				status={{ state: "crashed" }}
				tooLarge={false}
				onRestart={vi.fn()}
			/>
		</>,
	);
	expect(announced("a.py")).toBe("Code help stopped");
	expect(announced("a.ts")).toBe("Code help stopped");
});

test("too large belongs to one file, so each large file announces it", () => {
	render(
		<>
			{bar("a.py", { state: "ready" }, true)}
			{bar("b.py", { state: "ready" }, true)}
		</>,
	);
	expect(announced("a.py")).toMatch(/512 KB/);
	expect(announced("b.py")).toMatch(/512 KB/);
});

test("a hidden bar does not announce, so the shown one does", () => {
	const crashed: ServerStatus = { state: "crashed" };
	render(
		<>
			{bar("a.py", crashed, false, false)}
			{bar("b.py", crashed)}
		</>,
	);
	expect(announced("a.py")).toBe("");
	expect(announced("b.py")).toBe("Code help stopped");
});

test("a hidden bar that is shown again does not announce a second time", () => {
	const crashed: ServerStatus = { state: "crashed" };
	const { rerender } = render(
		<>
			{bar("a.py", crashed, false, false)}
			{bar("b.py", crashed)}
		</>,
	);
	rerender(
		<>
			{bar("a.py", crashed)}
			{bar("b.py", crashed)}
		</>,
	);
	expect(announced("a.py")).toBe("");
	expect(announced("b.py")).toBe("Code help stopped");
});

test("a bar that becomes hidden hands the announcement to the shown one", () => {
	const crashed: ServerStatus = { state: "crashed" };
	const { rerender } = render(
		<>
			{bar("a.py", crashed)}
			{bar("b.py", crashed)}
		</>,
	);
	rerender(
		<>
			{bar("a.py", crashed, false, false)}
			{bar("b.py", crashed)}
		</>,
	);
	expect(announced("a.py")).toBe("");
	expect(announced("b.py")).toBe("Code help stopped");
});
