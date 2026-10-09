import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { FilePane } from "./FilePane.js";

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

function renderPane() {
	return render(
		<FilePane
			path="src/app.ts"
			alone={false}
			focused={true}
			dropEdge={null}
			moveTargets={[]}
			onFocus={() => {}}
			onMoveToNewTab={() => {}}
			onMoveInto={() => {}}
			onResetSizes={() => {}}
			onClose={() => {}}
		>
			<p>body</p>
		</FilePane>,
	);
}

/** SPEC.md §25.8: a moved pane catches the keyboard its old place dropped. */
test("a focused pane mounting while the keyboard is nowhere takes it", () => {
	renderPane();
	expect(document.activeElement).toBe(
		screen.getByTestId("file-frame-actions-src/app.ts"),
	);
});

/** A remount, such as a rename from the file tree, leaves the keyboard where it is. */
test("a focused pane mounting while the keyboard is elsewhere leaves it there", () => {
	const elsewhere = document.createElement("button");
	document.body.append(elsewhere);
	elsewhere.focus();
	renderPane();
	expect(document.activeElement).toBe(elsewhere);
});
