import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { FileHeader, FilePane } from "./FilePane.js";

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

function renderPane(path = "src/app.ts") {
	return render(
		<FilePane
			path={path}
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
			<FileHeader path={path}>
				<button type="button">Edit</button>
			</FileHeader>
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

/** SPEC.md §8.3: the name, the view's controls and the menu share one line, in that order. */
test("the pane has one header: the name as drag handle, the view's controls, then the menu", () => {
	renderPane();
	const pane = screen.getByRole("region", { name: "File: src/app.ts" });
	const headers = pane.querySelectorAll("header");
	expect(headers).toHaveLength(1);
	const header = headers[0] as HTMLElement;
	const handle = screen.getByTestId("file-frame-handle-src/app.ts");
	const edit = screen.getByRole("button", { name: "Edit" });
	const actions = screen.getByTestId("file-frame-actions-src/app.ts");
	expect(handle.textContent).toBe("app.ts");
	expect(handle.getAttribute("title")).toBe("src/app.ts");
	const order = [handle, edit, actions].map((element) => {
		expect(header.contains(element)).toBe(true);
		return element;
	});
	for (let at = 1; at < order.length; at += 1) {
		const before = order[at - 1] as HTMLElement;
		const after = order[at] as HTMLElement;
		expect(
			before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	}
	expect(actions.getAttribute("aria-label")).toBe("Actions for app.ts");
});

/** SPEC.md §9.3: the whole bar is the drag handle, but no focus stop; the keyboard moves the pane through the menu. */
test("the whole title bar is the drag handle and takes no tab stop", () => {
	renderPane();
	const pane = screen.getByRole("region", { name: "File: src/app.ts" });
	const header = pane.querySelector("header");
	expect(header?.classList.contains("pk-filepane-handle")).toBe(true);
	expect(header?.hasAttribute("tabindex")).toBe(false);
	expect(header?.hasAttribute("role")).toBe(false);
	const name = screen.getByTestId("file-frame-handle-src/app.ts");
	expect(name.hasAttribute("tabindex")).toBe(false);
});

/** SPEC.md §24.6: neither the name nor the pane's label draws a bidirectional mark. */
test("the name and the pane's label never draw a bidirectional mark", () => {
	renderPane("src/‮txt.js");
	expect(screen.getByRole("region", { name: "File: src/txt.js" })).not.toBeNull();
	expect(screen.getByTestId("file-frame-handle-src/‮txt.js").textContent).toBe("txt.js");
});

test("outside a file pane the header shows the name and folder and no menu", () => {
	const { container } = render(<FileHeader path="notes/todo.md" />);
	expect(container.querySelector("header")?.className).toBe("pk-file-header");
	expect(screen.getByText("todo.md").getAttribute("title")).toBe("notes/todo.md");
	expect(screen.getByTestId("file-header-dir-notes/todo.md").textContent).toBe("notes");
	expect(screen.queryByRole("button")).toBeNull();
});

test("the header shows the folder, muted, after the name", () => {
	renderPane("src/lib/app.ts");
	const handle = screen.getByTestId("file-frame-handle-src/lib/app.ts");
	const folder = screen.getByTestId("file-header-dir-src/lib/app.ts");
	expect(handle.textContent).toBe("app.ts");
	expect(folder.textContent).toBe("src/lib");
	expect(folder.className).toBe("pk-file-dir");
	expect(handle.nextElementSibling).toBe(folder);
});

test("a file at the project root shows no folder", () => {
	renderPane("README.md");
	expect(screen.queryByTestId("file-header-dir-README.md")).toBeNull();
});

test("the folder is drawn without direction controls", () => {
	renderPane("‮evil/app.ts");
	expect(screen.getByTestId("file-header-dir-‮evil/app.ts").textContent).toBe("evil");
});
