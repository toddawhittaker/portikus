import type { ChatCommand } from "@portikus/contracts";
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Composer } from "./Composer.js";
import { matchCommands, mention } from "./ComposerCommandMenu.js";
import { type ChatStore, createChatStore } from "./chatStore.js";
import { boxText, typeInto } from "./composerTesting.js";

/**
 * The composer's `/` and `@` menus (SPEC.md §10.8, §25.8): the box is
 * the combobox, the list a listbox, keys stay in the box, a terminal-only
 * command is never sent, and file searches wait, cancel and fail quietly.
 */

const TERMINAL = "11111111-1111-4111-8111-111111111111";

const COMMANDS: ChatCommand[] = [
	{
		name: "compact",
		description: "Summarise the conversation so far",
		argumentHint: "[focus]",
		terminalOnly: false,
	},
	{ name: "review", description: "Review a pull request", terminalOnly: false },
	{ name: "config", description: "Open the settings", terminalOnly: true },
	{ name: "model", description: "Choose the model", terminalOnly: true },
	{
		name: "pr-comments",
		description: "Show a pull request's comments",
		terminalOnly: false,
	},
];

let sent: unknown[];
let store: ChatStore;
let seq: number;
/** Each file search the page made: its body and signal, and a way to answer it. */
let searches: {
	body: { query: string; limit: number };
	signal: AbortSignal;
	answer: (response: Response) => void;
}[];

function emit(type: string, body: Record<string, unknown> = {}) {
	act(() => {
		store
			.getState()
			.receive(JSON.stringify({ type, sessionId: TERMINAL, seq: seq++, ...body }));
	});
}

// jsdom has no layout; the editor scrolls a choice into view through these.
const NO_RECTS = () => [] as unknown as DOMRectList;
const NO_RECT = () => new DOMRect();

beforeEach(() => {
	Range.prototype.getClientRects = NO_RECTS;
	Range.prototype.getBoundingClientRect = NO_RECT;
	Element.prototype.scrollIntoView = () => {};
	sent = [];
	seq = 0;
	searches = [];
	store = createChatStore((message) => {
		sent.push(message);
		return true;
	});
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
	emit("settings", {
		agent: "claude",
		model: "claude-sonnet-4-5",
		effort: "medium",
		mode: "default",
	});
	// The host's command list, as its `commands` event leaves it in the store.
	act(() => store.setState({ commands: COMMANDS }));
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, init?: RequestInit) => {
			if (!String(url).endsWith("/file-search")) {
				return Promise.resolve(
					Response.json({ ...EDITOR_SETTINGS_DEFAULTS, timezones: [] }),
				);
			}
			return new Promise<Response>((resolve, reject) => {
				const signal = init?.signal as AbortSignal;
				signal.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
				searches.push({
					body: JSON.parse(String(init?.body)),
					signal,
					answer: resolve,
				});
			});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function draw() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ToastProvider>
				<Composer
					store={store}
					readAloud={{ on: false, set: () => {} }}
					workspaceId="w"
					projectId="p"
					terminalId={TERMINAL}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	const box = screen.getByTestId("chat-composer-input");
	act(() => box.focus());
	return box;
}

const options = () => screen.getAllByRole("option");
const menuStatus = () => screen.getByTestId("composer-menu-status").textContent;
const key = (box: HTMLElement, name: string) => fireEvent.keyDown(box, { key: name });

test("/ at the start lists every command with its line and hint, and narrows as you type", async () => {
	const box = draw();
	typeInto(box, "/");
	const list = await screen.findByRole("listbox", { name: "Commands" });
	expect(options().map((one) => one.textContent)).toEqual([
		"/compact[focus]Summarise the conversation so far",
		"/reviewReview a pull request",
		"/configUse the terminalOpen the settings",
		"/modelUse the Model pickerChoose the model",
		"/pr-commentsShow a pull request's comments",
	]);
	expect(menuStatus()).toBe("5 commands");
	// The box is the combobox: it owns the list and names the current option.
	expect(box.getAttribute("aria-expanded")).toBe("true");
	expect(box.getAttribute("aria-controls")).toBe(list.id);
	expect(box.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
	expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
	typeInto(box, "co");
	await waitFor(() =>
		expect(options().map((one) => one.textContent?.split(/[A-Z[]/)[0])).toEqual([
			"/compact",
			"/config",
			"/pr-comments",
		]),
	);
	expect(menuStatus()).toBe("3 commands");
	typeInto(box, "zzz");
	await waitFor(() => expect(screen.queryAllByRole("option")).toEqual([]));
	expect(screen.getByTestId("composer-menu-note").textContent).toBe(
		"No matching commands",
	);
	expect(box.getAttribute("aria-expanded")).toBe("false");
});

test("arrows move through the list, wrapping, and Enter puts the command in the box without sending", async () => {
	const box = draw();
	typeInto(box, "/");
	await screen.findByRole("listbox");
	key(box, "ArrowDown");
	expect(box.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
	key(box, "ArrowUp");
	key(box, "ArrowUp");
	expect(box.getAttribute("aria-activedescendant")).toBe(options()[4]?.id);
	key(box, "ArrowDown");
	key(box, "Enter");
	expect(boxText(box)).toBe("/compact ");
	expect(sent).toEqual([]);
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	expect(box.getAttribute("aria-expanded")).toBe("false");
	// The menu closed, Enter sends again.
	key(box, "Enter");
	expect(sent).toEqual([{ type: "send", text: "/compact ", attachments: [] }]);
});

test("Tab chooses once the arrows have picked an option, and the box keeps the keyboard", async () => {
	const box = draw();
	typeInto(box, "/re");
	await screen.findByRole("listbox");
	key(box, "ArrowDown");
	key(box, "ArrowUp");
	key(box, "Tab");
	expect(boxText(box)).toBe("/review ");
	expect(document.activeElement).toBe(box);
});

test("Tab with no arrow pressed inserts nothing: the menu closes and Tab moves on", async () => {
	const box = draw();
	typeInto(box, "email me @");
	await waitFor(() => expect(searches).toHaveLength(1));
	await act(async () =>
		searches[0]?.answer(Response.json({ paths: ["me.ts"], truncated: false })),
	);
	await screen.findByRole("listbox");
	// Tab is not handled by the menu, so the browser's focus move goes ahead.
	expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
	expect(boxText(box)).toBe("email me @");
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	// Enter still chooses without an arrow.
	typeInto(box, "x");
	await waitFor(() => expect(searches).toHaveLength(2));
	await act(async () =>
		searches[1]?.answer(Response.json({ paths: ["mex.ts"], truncated: false })),
	);
	await screen.findByRole("listbox");
	key(box, "Enter");
	expect(boxText(box)).toBe("email me @mex.ts ");
});

test("a list that changes after the arrows moved needs them again before Tab chooses", async () => {
	const box = draw();
	typeInto(box, "/");
	await screen.findByRole("listbox");
	key(box, "ArrowDown");
	typeInto(box, "re");
	await waitFor(() => expect(options()).toHaveLength(1));
	expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
	expect(boxText(box)).toBe("/re");
});

test("a click on an option chooses it, and the box keeps the keyboard", async () => {
	const box = draw();
	typeInto(box, "/");
	await screen.findByRole("listbox");
	const review = options()[1] as HTMLElement;
	expect(fireEvent.mouseDown(review)).toBe(false);
	fireEvent.click(review);
	expect(boxText(box)).toBe("/review ");
});

test("Escape closes the menu and leaves the running turn alone; the next Escape stops it", async () => {
	const box = draw();
	emit("turn.started", { at: 0 });
	typeInto(box, "/co");
	await screen.findByRole("listbox");
	key(box, "Escape");
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	expect(sent).toEqual([]);
	expect(boxText(box)).toBe("/co");
	key(box, "Escape");
	expect(sent).toEqual([{ type: "interrupt" }]);
});

test("/ later in the message, or with no commands listed, opens no list", async () => {
	act(() => store.setState({ commands: [] }));
	const box = draw();
	typeInto(box, "/");
	await waitFor(() =>
		expect(screen.getByTestId("composer-menu-note").textContent).toBe(
			"No matching commands",
		),
	);
	expect(screen.queryByRole("listbox")).toBeNull();
	key(box, "Enter");
	expect(sent).toHaveLength(1);
});

test("a terminal-only command is dimmed and never sent; Enter on it says why", async () => {
	const box = draw();
	typeInto(box, "/conf");
	await screen.findByRole("listbox");
	const config = options()[0] as HTMLElement;
	expect(config.getAttribute("aria-disabled")).toBe("true");
	expect(config.className).toContain("is-blocked");
	key(box, "Enter");
	expect(sent).toEqual([]);
	expect(boxText(box)).toBe("/conf");
	expect(screen.getByTestId("chat-composer-status").textContent).toBe(
		"/config works only in the terminal, so it is not sent.",
	);
});

test("/model, terminal-only, opens the Model picker in its place", async () => {
	const box = draw();
	typeInto(box, "/mod");
	await screen.findByRole("listbox");
	const model = options()[0] as HTMLElement;
	expect(model.getAttribute("aria-disabled")).toBeNull();
	key(box, "Enter");
	expect(sent).toEqual([]);
	expect(boxText(box)).toBe("");
	const menu = await screen.findByRole("menu", { name: /^Model / });
	expect(within(menu).getAllByRole("menuitemradio").length).toBeGreaterThan(1);
});

test("the list hides while the box does not hold focus, and comes back with it", async () => {
	const box = draw();
	typeInto(box, "/");
	await screen.findByRole("listbox");
	act(() => box.blur());
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(box.getAttribute("aria-expanded")).toBe("false");
	act(() => box.focus());
	expect(await screen.findByRole("listbox")).toBeTruthy();
});

test("@ searches file names after a pause, lists them, and Enter inserts the mention", async () => {
	const box = draw();
	typeInto(box, "look at @ap");
	expect(searches).toEqual([]);
	await waitFor(() => expect(searches).toHaveLength(1));
	expect(searches[0]?.body).toEqual({ query: "ap", limit: 20 });
	expect(screen.getByTestId("composer-menu-note").textContent).toBe("Searching…");
	await act(async () =>
		searches[0]?.answer(
			Response.json({ paths: ["src/app.ts", "app.css"], truncated: false }),
		),
	);
	const list = await screen.findByRole("listbox", { name: "Files" });
	expect(
		within(list)
			.getAllByRole("option")
			.map((one) => one.getAttribute("aria-label")),
	).toEqual(["src/app.ts", "app.css"]);
	expect(options()[0]?.textContent).toBe("app.tssrc");
	expect(menuStatus()).toBe("2 files");
	key(box, "Enter");
	expect(boxText(box)).toBe("look at @src/app.ts ");
	expect(sent).toEqual([]);
});

test("a newer query cancels the search in flight, whose late answer is never shown", async () => {
	const box = draw();
	typeInto(box, "@a");
	await waitFor(() => expect(searches).toHaveLength(1));
	typeInto(box, "b");
	expect(searches[0]?.signal.aborted).toBe(true);
	await waitFor(() => expect(searches).toHaveLength(2));
	expect(searches[1]?.body.query).toBe("ab");
	await act(async () =>
		searches[1]?.answer(Response.json({ paths: ["ab.ts"], truncated: false })),
	);
	await screen.findByRole("listbox");
	expect(options().map((one) => one.getAttribute("aria-label"))).toEqual(["ab.ts"]);
});

test("while a newer query waits, the last answer is not selectable, so Enter cannot insert from it", async () => {
	const box = draw();
	typeInto(box, "@ap");
	await waitFor(() => expect(searches).toHaveLength(1));
	await act(async () =>
		searches[0]?.answer(Response.json({ paths: ["apple.ts"], truncated: false })),
	);
	await screen.findByRole("listbox");
	// A longer query is typed; its search has not gone out yet.
	typeInto(box, "p.t");
	expect(searches).toHaveLength(1);
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(box.getAttribute("aria-expanded")).toBe("false");
	expect(screen.getByTestId("composer-menu-note").textContent).toBe("Searching…");
	key(box, "Enter");
	expect(boxText(box)).not.toContain("apple.ts");
	// Its own answer is selectable once it arrives.
	await waitFor(() => expect(searches).toHaveLength(2));
	await act(async () =>
		searches[1]?.answer(Response.json({ paths: ["app.tsx"], truncated: false })),
	);
	await screen.findByRole("listbox");
	expect(options().map((one) => one.getAttribute("aria-label"))).toEqual(["app.tsx"]);
});

test("no match says so, more than the limit says so, and a failure is quiet", async () => {
	const box = draw();
	typeInto(box, "@zz");
	await waitFor(() => expect(searches).toHaveLength(1));
	await act(async () =>
		searches[0]?.answer(Response.json({ paths: [], truncated: false })),
	);
	await waitFor(() =>
		expect(screen.getByTestId("composer-menu-note").textContent).toBe(
			"No matching files",
		),
	);
	expect(menuStatus()).toBe("No matching files");
	key(box, "Enter");
	expect(sent).toHaveLength(1);

	typeInto(box, " @s");
	await waitFor(() => expect(searches).toHaveLength(2));
	const many = Array.from({ length: 20 }, (_, at) => `src/file-${at}.ts`);
	await act(async () =>
		searches[1]?.answer(Response.json({ paths: many, truncated: true })),
	);
	await waitFor(() => expect(options()).toHaveLength(20));
	expect(screen.getByTestId("composer-menu-note").textContent).toBe(
		"20 files, more not shown; type more to narrow",
	);

	typeInto(box, "x");
	await waitFor(() => expect(searches).toHaveLength(3));
	await act(async () =>
		searches[2]?.answer(
			Response.json({ error: { code: "BUSY", message: "busy" } }, { status: 409 }),
		),
	);
	await waitFor(() =>
		expect(screen.getByTestId("composer-menu-note").textContent).toBe(
			"Files could not be searched just now",
		),
	);
	expect(screen.getByTestId("chat-composer-error").textContent).toBe("");
});

test("commands that start with the query come before those that only contain it", () => {
	expect(matchCommands(COMMANDS, "C").map((one) => one.label)).toEqual([
		"/compact",
		"/config",
		"/pr-comments",
	]);
	expect(matchCommands(COMMANDS, "model")[0]).toMatchObject({
		insert: null,
		note: "Use the Model picker",
		control: "composer-model",
	});
});

test("a path with a space is quoted, as the CLI reads a mention", () => {
	expect(mention("src/app.ts")).toBe("@src/app.ts");
	expect(mention("docs/my notes.md")).toBe('@"docs/my notes.md"');
});
