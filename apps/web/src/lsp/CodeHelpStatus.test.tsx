import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeHelpStatus } from "./CodeHelpStatus.js";
import type { ServerStatus } from "./store.js";

afterEach(cleanup);

function show(status: ServerStatus, tooLarge = false) {
	render(
		<CodeHelpStatus
			path="a.py"
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
