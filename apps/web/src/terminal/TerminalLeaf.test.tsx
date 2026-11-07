import { readFileSync } from "node:fs";
import type { Terminal } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	createEvent,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { editorSettingsKey } from "../editor/settingsQueries";
import { setDraggedTreeNodes } from "../files/treeDrag";
import { TREE_DRAG_TYPE } from "../files/useTreeDragAndDrop";
import { shortenPath, TerminalLeaf } from "./TerminalLeaf";

/** What the mocked terminal was asked to type, in order. */
const typed = vi.hoisted(() => vi.fn());

/** Settings already cached, so the voice button never fetches them. */
function SettingsCache({ children }: { children: ReactNode }) {
	const [client] = useState(() => {
		const made = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity } },
		});
		made.setQueryData(editorSettingsKey, { voiceInputEnabled: true });
		made.setQueryData(
			["projects", "22222222-2222-4222-8222-222222222222", "active"],
			[{ id: "33333333-3333-4333-8333-333333333333", slug: "todo-api" }],
		);
		return made;
	});
	return (
		<QueryClientProvider client={client}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
}

// The pane itself is covered by TerminalPane.test.tsx; here it would only drag
// xterm.js and a WebSocket into the test.
vi.mock("./TerminalPane", () => ({
	TerminalPane: ({
		terminal,
		onCwd,
		onVoiceHold,
		dictation,
	}: {
		terminal: Terminal;
		onCwd: (path: string) => void;
		onVoiceHold?: (held: boolean) => void;
		dictation?: { current: ((text: string) => void) | null };
	}) => {
		if (dictation) dictation.current = typed;
		return (
			<>
				<button
					type="button"
					data-testid={`terminal-pane-${terminal.id}`}
					onClick={() => onCwd("/home/student/projects/todo-api/src")}
				/>
				{onVoiceHold ? (
					<button
						type="button"
						data-testid="voice-shortcut"
						onClick={() => onVoiceHold(true)}
					/>
				) : null}
			</>
		);
	},
}));

// The chat view has its own tests; here it stands in for the pane's content.
vi.mock("../chat/ChatView", () => ({
	ChatView: ({ terminalId, visible }: { terminalId: string; visible: boolean }) => (
		<div data-testid={`chat-view-${terminalId}`} data-visible={String(visible)} />
	),
}));

afterEach(() => {
	cleanup();
	typed.mockReset();
	setDraggedTreeNodes([]);
	vi.unstubAllGlobals();
});

const terminal: Terminal = {
	id: "44444444-4444-4444-8444-444444444444",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	name: "zsh",
	cwd: "/home/student/projects/todo-api",
	position: 0,
	projectId: "33333333-3333-4333-8333-333333333333",
	createdAt: "2026-01-01T00:00:00.000Z",
	endedAt: null,
	theme: "dark",
	kind: "terminal",
};

function renderLeaf(
	overrides: Partial<Terminal> = {},
	handlers: Record<string, ReturnType<typeof vi.fn>> = {},
	alone = false,
	moveTargets: { tabId: string; label: string }[] = [],
) {
	const props = {
		onFocus: vi.fn(),
		onSplit: vi.fn(),
		onRename: vi.fn(),
		onSetTheme: vi.fn(),
		onClose: vi.fn(),
		onExited: vi.fn(),
		onReplace: vi.fn(),
		onLeave: vi.fn(),
		onMoveToNewTab: vi.fn(),
		onMoveInto: vi.fn(),
		onResetSizes: vi.fn(),
		...handlers,
	};
	const element = (next: Partial<Terminal>) => (
		<TerminalLeaf
			workspaceId={terminal.workspaceId}
			projectId="33333333-3333-4333-8333-333333333333"
			terminal={{ ...terminal, ...next }}
			visible={true}
			focused={false}
			onFocus={props.onFocus}
			onSplit={props.onSplit}
			onRename={props.onRename}
			onSetTheme={props.onSetTheme}
			onClose={props.onClose}
			onExited={props.onExited}
			onReplace={props.onReplace}
			onLeave={props.onLeave}
			onMoveToNewTab={props.onMoveToNewTab}
			moveTargets={moveTargets}
			onMoveInto={props.onMoveInto}
			onResetSizes={props.onResetSizes}
			alone={alone}
		/>
	);
	const { rerender } = render(element(overrides), { wrapper: SettingsCache });
	return { ...props, rerender: (next: Partial<Terminal>) => rerender(element(next)) };
}

test("the bar shows the name and the home-relative directory", () => {
	renderLeaf();
	expect(screen.getByText("zsh · ~/projects/todo-api")).toBeTruthy();
	expect(shortenPath("/home/student/projects/x")).toBe("~/projects/x");
	expect(shortenPath("/srv/elsewhere")).toBe("/srv/elsewhere");
});

test("the actions menu splits right and down", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("split-right"));
	expect(props.onSplit).toHaveBeenCalledWith(terminal.id, "row");

	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("split-down"));
	expect(props.onSplit).toHaveBeenCalledWith(terminal.id, "column");
});

/** Radix returns focus on a timeout, so wait that turn out before asserting. */
async function flushCloseFocus() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("dismissing the actions menu with the pointer does not focus it", async () => {
	renderLeaf();
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
	await flushCloseFocus();
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).not.toBe(trigger);
});

test("closing the actions menu from the keyboard focuses it", async () => {
	renderLeaf();
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

test("the actions menu closes the terminal", async () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("terminal-close"));
	await waitFor(() => expect(props.onClose).toHaveBeenCalledWith(terminal.id));
});

test("Rename swaps the title for a field and saves on Enter", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("terminal-rename"));
	const field = screen.getByTestId("terminal-rename-field");
	fireEvent.change(field, { target: { value: "server" } });
	fireEvent.keyDown(field, { key: "Enter" });
	expect(props.onRename).toHaveBeenCalledWith(terminal.id, "server");
});

test("an ended terminal keeps its pane and offers a new one", () => {
	const props = renderLeaf({ endedAt: "2026-01-02T00:00:00.000Z" });
	expect(screen.getByTestId(`terminal-ended-${terminal.id}`).textContent).toContain(
		"This terminal ended when the workspace stopped",
	);
	expect(screen.queryByTestId(`terminal-pane-${terminal.id}`)).toBeNull();
	fireEvent.click(screen.getByTestId("new-terminal-here"));
	expect(props.onReplace).toHaveBeenCalledWith(terminal.id);
});

test("the bar follows the directory the agent reports", () => {
	renderLeaf();
	expect(screen.getByText("zsh · ~/projects/todo-api")).toBeTruthy();
	fireEvent.click(screen.getByTestId(`terminal-pane-${terminal.id}`));
	expect(screen.getByText("zsh · ~/projects/todo-api/src")).toBeTruthy();
});

/**
 * The pane menu is where one terminal changes its colours. The
 * item is one checkbox with a fixed name, checked when the terminal is light.
 */
test("the actions menu has a Light terminal checkbox, off for a dark terminal", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	const toggle = screen.getByRole("menuitemcheckbox", { name: "Light terminal" });
	expect(toggle.getAttribute("aria-checked")).toBe("false");
	expect(toggle.getAttribute("title")).toBeNull();
	fireEvent.click(toggle);
	expect(props.onSetTheme).toHaveBeenCalledWith(terminal.id, "light");
});

test("a light terminal has the checkbox on, and unchecking it asks for dark", () => {
	const props = renderLeaf({ theme: "light" });
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	const toggle = screen.getByRole("menuitemcheckbox", { name: "Light terminal" });
	expect(toggle.getAttribute("aria-checked")).toBe("true");
	fireEvent.click(toggle);
	expect(props.onSetTheme).toHaveBeenCalledWith(terminal.id, "dark");
});

/**
 * The pane carries its own colour scheme, so the --terminal-*
 * tokens that colour the title bar and the scrollbar come from this pane
 * rather than from the per-user default on the document.
 */
test("the pane carries the terminal's own colour scheme", () => {
	const paneId = `terminal-leaf-${terminal.id}`;
	renderLeaf();
	expect(screen.getByTestId(paneId).getAttribute("data-terminal-theme")).toBe("dark");
	cleanup();
	renderLeaf({ theme: "light" });
	expect(screen.getByTestId(paneId).getAttribute("data-terminal-theme")).toBe("light");
});

function openActions() {
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
}

/** A pane can leave its split without a drag (WCAG 2.5.7). */
test("Move to new tab moves this pane without a drag", () => {
	const props = renderLeaf();
	openActions();
	fireEvent.click(screen.getByTestId("terminal-move-to-new-tab"));
	expect(props.onMoveToNewTab).toHaveBeenCalledWith(terminal.id);
});

test("Move to new tab is disabled for a pane that is already alone in its tab", () => {
	renderLeaf({}, {}, true);
	openActions();
	const item = screen
		.getByTestId("terminal-move-to-new-tab")
		.closest('[role="menuitem"]');
	expect(item?.getAttribute("aria-disabled")).toBe("true");
});

/** A pane can join another tab's split without a drag (WCAG 2.5.7). */
test("Move into lists the other tabs and moves this pane into the one chosen", () => {
	const props = renderLeaf({}, {}, false, [
		{ tabId: "tab-b", label: "bash" },
		{ tabId: "tab-c", label: "Claude Code" },
	]);
	openActions();
	fireEvent.click(screen.getByRole("menuitem", { name: "Move into" }));
	const submenu = screen.getByRole("menu", { name: "Move into" });
	expect(
		[...submenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
	).toEqual(["bash", "Claude Code"]);

	fireEvent.click(screen.getByTestId("terminal-move-into-tab-c"));
	expect(props.onMoveInto).toHaveBeenCalledWith(terminal.id, "tab-c");
});

test("Move into is disabled when no other tab can take the pane", () => {
	renderLeaf();
	openActions();
	expect(
		screen.getByRole("menuitem", { name: "Move into" }).getAttribute("aria-disabled"),
	).toBe("true");
});

/** Splitters have a click alternative to dragging them (WCAG 2.5.7). */
test("Reset pane sizes asks the tab to share its space out evenly", () => {
	const props = renderLeaf();
	openActions();
	fireEvent.click(screen.getByTestId("terminal-reset-sizes"));
	expect(props.onResetSizes).toHaveBeenCalled();
});

test("Reset pane sizes is disabled for a pane alone in its tab", () => {
	renderLeaf({}, {}, true);
	openActions();
	const item = screen.getByTestId("terminal-reset-sizes").closest('[role="menuitem"]');
	expect(item?.getAttribute("aria-disabled")).toBe("true");
});

/** The menu says how to leave the terminal and does it. */
test("Leave terminal names Alt+Shift+Q and leaves the terminal", async () => {
	const outside = document.createElement("button");
	document.body.append(outside);
	const props = renderLeaf({}, { onLeave: vi.fn(() => outside.focus()) });
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	const item = screen.getByTestId("terminal-leave").closest('[role="menuitem"]');
	expect(item?.getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+Q");
	fireEvent.click(screen.getByTestId("terminal-leave"));
	await flushCloseFocus();
	expect(props.onLeave).toHaveBeenCalled();
	// The menu does not pull the keyboard back to its trigger.
	expect(document.activeElement).toBe(outside);
	outside.remove();
});

/**
 * The focus ring follows the pane's own scheme, so it keeps 3:1
 * on a light terminal in a dark page and on a dark terminal in a light page.
 */
test("each terminal scheme sets its own focus colour", async () => {
	const css = readFileSync(`${import.meta.dirname}/../work/work.css`, "utf8").replace(
		/\s+/g,
		" ",
	);
	expect(css).toContain(
		'.pk-term[data-terminal-theme="light"] { --focus: var(--focus-on-light); }',
	);
	expect(css).toContain(
		'.pk-term[data-terminal-theme="dark"] { --focus: var(--focus-on-dark); }',
	);
	const theme = readFileSync(
		`${import.meta.dirname}/../../../../packages/ui/src/theme.css`,
		"utf8",
	);
	expect(theme).toContain("--focus-on-light: #1b7a86;");
	expect(theme).toContain("--focus-on-dark: #5fc3cf;");
});

/** Enough of a recognizer to see it start and stop. */
class FakeRecognition {
	static last: FakeRecognition | null = null;
	continuous = false;
	interimResults = false;
	lang = "";
	onresult = null;
	onerror = null;
	onend = null;
	stopped = false;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {}
	stop() {
		this.stopped = true;
	}
	abort() {}
}

test("a terminal that ends while dictating stops listening", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	try {
		const { rerender } = renderLeaf();
		fireEvent.click(screen.getByTestId("voice-shortcut"));
		expect(FakeRecognition.last?.stopped).toBe(false);
		rerender({ endedAt: "2026-01-02T00:00:00.000Z" });
		expect(FakeRecognition.last?.stopped).toBe(true);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("without speech support the terminal keeps Alt+Shift+M", () => {
	renderLeaf();
	expect(screen.queryByTestId("voice-shortcut")).toBeNull();
});

// Dropping on the terminal (SPEC.md §9.6).

const PANE_ID = `terminal-pane-${terminal.id}`;
const PATH_START = "/home/student/projects/todo-api";

/** A drag with the given types and data, as the browser hands one to the pane. */
function dragData(
	types: string[],
	data: Record<string, string> = {},
	files: File[] = [],
) {
	return {
		types,
		files,
		dropEffect: "none",
		getData: (type: string) => data[type] ?? "",
	};
}

/** Give the pane a size, since jsdom lays nothing out. */
function sizePane() {
	const section = screen.getByTestId(`terminal-leaf-${terminal.id}`);
	section.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
}

const MIDDLE = { clientX: 150, clientY: 150 };
const RIGHT_EDGE = { clientX: 290, clientY: 150 };

/** jsdom has no DragEvent, so the pointer position is put on the event by hand. */
function drag(
	type: "dragOver" | "drop",
	target: Element,
	init: { dataTransfer: ReturnType<typeof dragData> } & Partial<typeof MIDDLE>,
) {
	const event = createEvent[type](target, { dataTransfer: init.dataTransfer });
	Object.defineProperties(event, {
		clientX: { value: init.clientX ?? 0 },
		clientY: { value: init.clientY ?? 0 },
	});
	fireEvent(target, event);
}

/** A real tree drag records its rows in the page; forged drag data does not. */
function dragTreeRows(...paths: string[]) {
	setDraggedTreeNodes(
		paths.map((path) => ({ path, name: path, isDir: false })) as never,
	);
}

test("a tree row dropped on the middle types its quoted absolute path, without Enter", () => {
	renderLeaf();
	sizePane();
	const target = screen.getByTestId(PANE_ID);
	dragTreeRows("my docs/a b.md");
	const dataTransfer = dragData([TREE_DRAG_TYPE], {
		[TREE_DRAG_TYPE]: "my docs/a b.md",
	});
	drag("dragOver", target, { dataTransfer, ...MIDDLE });
	expect(screen.getByTestId(`file-drop-target-${terminal.id}`)).not.toBeNull();
	expect(dataTransfer.dropEffect).toBe("move");
	drag("drop", target, { dataTransfer, ...MIDDLE });
	expect(typed).toHaveBeenCalledExactlyOnceWith(`'${PATH_START}/my docs/a b.md' `);
	expect(screen.queryByTestId(`file-drop-target-${terminal.id}`)).toBeNull();
});

test("a tree selection types every path, space separated", () => {
	renderLeaf();
	sizePane();
	const node = (path: string) => ({
		path,
		name: path,
		isDir: false,
	});
	setDraggedTreeNodes([node("a.md"), node("src/it's.ts")] as never);
	const dataTransfer = dragData([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "a.md" });
	drag("drop", screen.getByTestId(PANE_ID), { dataTransfer, ...MIDDLE });
	expect(typed).toHaveBeenCalledExactlyOnceWith(
		`${PATH_START}/a.md '${PATH_START}/src/it'\\''s.ts' `,
	);
});

test("a tree row over an edge shows no target and types nothing", () => {
	renderLeaf();
	sizePane();
	const target = screen.getByTestId(PANE_ID);
	dragTreeRows("a.md");
	const dataTransfer = dragData([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "a.md" });
	drag("dragOver", target, { dataTransfer, ...RIGHT_EDGE });
	expect(screen.queryByTestId(`file-drop-target-${terminal.id}`)).toBeNull();
	drag("drop", target, { dataTransfer, ...RIGHT_EDGE });
	expect(typed).not.toHaveBeenCalled();
});

test("a drop carrying only the tree drag type, with no tree drag, types nothing", () => {
	renderLeaf();
	sizePane();
	const target = screen.getByTestId(PANE_ID);
	const dataTransfer = dragData([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "secret.md" });
	drag("dragOver", target, { dataTransfer, ...MIDDLE });
	expect(screen.queryByTestId(`file-drop-target-${terminal.id}`)).toBeNull();
	drag("drop", target, { dataTransfer, ...MIDDLE });
	expect(typed).not.toHaveBeenCalled();
});

test("a tree path with a control character is refused with a toast", async () => {
	renderLeaf();
	sizePane();
	dragTreeRows("a\nb.md");
	const dataTransfer = dragData([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "a\nb.md" });
	drag("drop", screen.getByTestId(PANE_ID), { dataTransfer, ...MIDDLE });
	expect(typed).not.toHaveBeenCalled();
	expect(
		await screen.findByText("That path cannot be typed into a terminal"),
	).not.toBeNull();
});

test("something that is not a file is ignored", () => {
	renderLeaf();
	sizePane();
	const target = screen.getByTestId(PANE_ID);
	const dataTransfer = dragData(["text/plain"], { "text/plain": "hi" });
	drag("dragOver", target, { dataTransfer, ...MIDDLE });
	drag("drop", target, { dataTransfer, ...MIDDLE });
	expect(screen.queryByTestId(`file-drop-target-${terminal.id}`)).toBeNull();
	expect(typed).not.toHaveBeenCalled();
});

test("leaving the pane hides the target", () => {
	renderLeaf();
	sizePane();
	const target = screen.getByTestId(PANE_ID);
	const dataTransfer = dragData(["Files"]);
	drag("dragOver", target, { dataTransfer, ...MIDDLE });
	expect(screen.getByTestId(`file-drop-target-${terminal.id}`)).not.toBeNull();
	fireEvent.dragLeave(target, { relatedTarget: document.body });
	expect(screen.queryByTestId(`file-drop-target-${terminal.id}`)).toBeNull();
});

/** Record every request the drop makes and answer each as the agent would. */
function stubUpload(answer: (url: string, init: RequestInit) => Response) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({ url, method: init.method ?? "GET", body: init.body });
			return answer(url, init);
		}),
	);
	return calls;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

test("desktop files are saved under a dated folder and their paths typed", async () => {
	const calls = stubUpload((url) =>
		url.includes("/mkdir") ? json({}) : json({ etag: "e", size: 1 }),
	);
	renderLeaf();
	sizePane();
	const shot = new File(["x"], "my shot.png", { type: "image/png" });
	const notes = new File(["y"], "notes.txt");
	const dataTransfer = dragData(["Files"], {}, [shot, notes]);
	drag("drop", screen.getByTestId(PANE_ID), { dataTransfer, ...RIGHT_EDGE });

	await waitFor(() => expect(typed).toHaveBeenCalledTimes(1));
	const puts = calls.filter((call) => call.method === "PUT");
	expect(puts).toHaveLength(2);
	for (const put of puts) {
		expect(decodeURIComponent(put.url)).toMatch(
			/path=\.portikus\/pastes\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\/(my shot\.png|notes\.txt)$/,
		);
	}
	const text = String(typed.mock.calls[0]?.[0]);
	expect(text).toMatch(
		new RegExp(
			`^'${PATH_START}/\\.portikus/pastes/[0-9T-]+/my shot\\.png' ${PATH_START}/\\.portikus/pastes/[0-9T-]+/notes\\.txt $`,
		),
	);
	expect(text).not.toMatch(/[\r\n]/);
});

test("a name already taken moves on to the next folder", async () => {
	let puts = 0;
	stubUpload((url) => {
		if (url.includes("/mkdir")) return json({});
		puts += 1;
		return puts === 1
			? json({ code: "FILE_EXISTS", message: "exists" }, 409)
			: json({ etag: "e", size: 1 });
	});
	renderLeaf();
	const dataTransfer = dragData(["Files"], {}, [new File(["x"], "a.png")]);
	drag("drop", screen.getByTestId(PANE_ID), { dataTransfer });
	await waitFor(() => expect(typed).toHaveBeenCalledTimes(1));
	expect(String(typed.mock.calls[0]?.[0])).toMatch(/pastes\/[0-9T-]+-2\/a\.png $/);
});

test("a name with a control character is refused and nothing is saved or typed", async () => {
	const calls = stubUpload(() => json({}));
	renderLeaf();
	const dataTransfer = dragData(["Files"], {}, [
		new File(["x"], "fine.png"),
		new File(["x"], "bad\u001b[2Jname.png"),
	]);
	drag("drop", screen.getByTestId(PANE_ID), { dataTransfer });
	expect(await screen.findByText(/cannot be dropped/)).not.toBeNull();
	expect(calls).toHaveLength(0);
	expect(typed).not.toHaveBeenCalled();
});

test("a file over the upload limit is refused and nothing is saved or typed", async () => {
	const calls = stubUpload(() => json({}));
	renderLeaf();
	const big = new File(["x"], "big.bin");
	Object.defineProperty(big, "size", { value: 50 * 1024 * 1024 + 1 });
	drag("drop", screen.getByTestId(PANE_ID), {
		dataTransfer: dragData(["Files"], {}, [big]),
	});
	expect(await screen.findByText(/must be 50 MB or smaller/)).not.toBeNull();
	expect(calls).toHaveLength(0);
	expect(typed).not.toHaveBeenCalled();
});

test("a failed upload shows a toast and types nothing", async () => {
	stubUpload((url) =>
		url.includes("/mkdir")
			? json({})
			: json({ code: "STORAGE_FULL", message: "full" }, 507),
	);
	renderLeaf();
	drag("drop", screen.getByTestId(PANE_ID), {
		dataTransfer: dragData(["Files"], {}, [new File(["x"], "a.png")]),
	});
	expect(await screen.findByText(/home folder is full/)).not.toBeNull();
	expect(typed).not.toHaveBeenCalled();
});

test("a chat tab shows the chat in the same frame, without the terminal's voice or theme", async () => {
	const props = renderLeaf({ kind: "chat", agent: "claude", name: "Claude Code" });
	expect((await screen.findByTestId(`chat-view-${terminal.id}`)).dataset.visible).toBe(
		"true",
	);
	expect(screen.queryByTestId(`terminal-pane-${terminal.id}`)).toBeNull();
	expect(screen.queryByTestId(`terminal-voice-${terminal.id}`)).toBeNull();
	expect(screen.getByText("Claude Code · ~/projects/todo-api")).toBeTruthy();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	expect(screen.queryByRole("menuitemcheckbox", { name: "Light terminal" })).toBeNull();
	fireEvent.click(screen.getByTestId("terminal-close"));
	await flushCloseFocus();
	expect(props.onClose).toHaveBeenCalledWith(terminal.id);
});

test("an ended chat says it ended and offers a new terminal", () => {
	const props = renderLeaf({
		kind: "chat",
		agent: "claude",
		endedAt: "2026-01-02T00:00:00.000Z",
	});
	expect(screen.getByTestId(`terminal-ended-${terminal.id}`).textContent).toContain(
		"This chat ended when the workspace stopped",
	);
	expect(screen.queryByTestId(`chat-view-${terminal.id}`)).toBeNull();
	fireEvent.click(screen.getByTestId("new-terminal-here"));
	expect(props.onReplace).toHaveBeenCalledWith(terminal.id);
});
