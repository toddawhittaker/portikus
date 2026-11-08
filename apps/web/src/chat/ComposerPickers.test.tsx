import { CHAT_START_EFFORT } from "@portikus/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { ASK_RULES_HINT, BYPASS_WARNING, ComposerPickers } from "./ComposerPickers.js";
import { type ChatState, type ChatStore, createChatStore } from "./chatStore.js";

type Settings = NonNullable<ChatState["settings"]>;

const START: Settings = {
	agent: "claude",
	model: "claude-sonnet-4-5",
	effort: CHAT_START_EFFORT,
	mode: "default",
};

let asked: unknown[];
let accept: boolean;
let announced: string[];
let store: ChatStore;
let rerender: (
	settings: ChatState["settings"],
	lastError?: ChatState["lastError"],
) => void;

function draw(settings: ChatState["settings"] = START) {
	store.setState({ settings });
	const view = (
		<>
			<ComposerPickers
				store={store}
				warningId="bypass-warning"
				onSet={(change) => {
					asked.push(change);
					return accept;
				}}
				onAnnounce={(text) => announced.push(text)}
			/>
			<p id="bypass-warning">{BYPASS_WARNING}</p>
		</>
	);
	render(view);
	rerender = (s, lastError = null) =>
		act(() => store.setState({ settings: s, lastError }));
}

function picker(name: string): HTMLElement {
	return screen.getByRole("button", { name: new RegExp(`^${name} `) });
}

/** What a screen reader would read as the description of `el`. */
function describedText(el: HTMLElement): string {
	return (el.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ")
		.trim();
}

function open(name: string): HTMLElement {
	fireEvent.keyDown(picker(name), { key: "Enter" });
	return screen.getByRole("menu", { name: new RegExp(`^${name} `) });
}

function choose(name: string, option: string) {
	const menu = open(name);
	fireEvent.click(within(menu).getByRole("menuitemradio", { name: option }));
}

beforeEach(() => {
	store = createChatStore(() => true);
	asked = [];
	accept = true;
	announced = [];
});

test("each picker is a menu button named by its label and the value shown", () => {
	draw({ ...START, model: "claude-opus-4-1", effort: "xhigh", mode: "plan" });
	expect(picker("Agent").textContent).toBe("Agent Claude Code");
	expect(picker("Model").textContent).toBe("Model Opus");
	expect(picker("Effort").textContent).toBe("Effort Extra high");
	expect(picker("Permissions").textContent).toBe("Permissions Plan");
	const model = picker("Model");
	expect(model.getAttribute("aria-haspopup")).toBe("menu");
	expect(model.getAttribute("aria-expanded")).toBe("false");
	open("Model");
	expect(model.getAttribute("aria-expanded")).toBe("true");
});

test("the menu marks the current value as checked and the start value as Default", () => {
	draw({ ...START, effort: "low" });
	const menu = open("Effort");
	const items = within(menu).getAllByRole("menuitemradio");
	expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
		"true",
		"false",
		"false",
		"false",
		"false",
	]);
	// The marker is a description, so the choice is still named just "High".
	const start = within(menu).getByRole("menuitemradio", { name: "High" });
	expect(start.querySelector(".pk-picker-default")?.textContent).toBe("Default");
	expect(menu.querySelectorAll(".pk-picker-default")).toHaveLength(1);
	expect(
		document.getElementById(start.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Default. Thinks it through. Slower, uses more.");
});

test("every choice says what it is for in a line of its own", () => {
	draw();
	for (const name of ["Agent", "Model", "Effort", "Permissions"]) {
		const menu = open(name);
		for (const item of within(menu).getAllByRole("menuitemradio")) {
			const line = document.getElementById(item.getAttribute("aria-describedby") ?? "");
			expect(line?.textContent?.length, item.textContent ?? "").toBeGreaterThan(5);
		}
		fireEvent.keyDown(menu, { key: "Escape" });
	}
});

test("each change asks for exactly that and shows it while the host has not answered", () => {
	draw({ ...START, model: "claude-opus-4-1" });
	choose("Model", "Haiku");
	choose("Effort", "Max");
	choose("Permissions", "Bypass permissions");
	expect(asked).toEqual([
		{ model: "haiku" },
		{ effort: "max" },
		{ mode: "bypassPermissions" },
	]);
	expect(picker("Model").textContent).toBe("Model Haiku");
	expect(picker("Permissions").textContent).toBe("Permissions Bypass permissions");
	rerender({ ...START, model: "haiku", effort: "max", mode: "bypassPermissions" });
	expect(picker("Model").textContent).toBe("Model Haiku");
	expect(picker("Effort").textContent).toBe("Effort Max");
});

test("choosing the value already shown asks for nothing", () => {
	draw();
	choose("Effort", "High");
	choose("Permissions", "Ask");
	expect(asked).toEqual([]);
});

test("a change that could not be sent is not shown", () => {
	accept = false;
	draw();
	choose("Effort", "Low");
	expect(asked).toEqual([{ effort: "low" }]);
	expect(picker("Effort").textContent).toBe("Effort High");
});

test("a change the host refuses goes back and is announced", () => {
	draw();
	choose("Effort", "Max");
	expect(picker("Effort").textContent).toBe("Effort Max");
	rerender(START, { seq: 7, message: "This model has no Max effort." });
	expect(picker("Effort").textContent).toBe("Effort High");
	expect(announced).toEqual([
		"Your effort did not change. This model has no Max effort.",
	]);
});

test("a value other than the start value is set apart, and Bypass carries the warning", () => {
	draw();
	const effort = picker("Effort");
	const mode = picker("Permissions");
	expect(effort.className).not.toContain("is-changed");
	expect(mode.hasAttribute("aria-describedby")).toBe(false);
	rerender({ ...START, effort: "low", mode: "bypassPermissions" });
	expect(effort.className).toContain("is-changed");
	expect(mode.className).toContain("is-warning");
	const warning = document.getElementById(mode.getAttribute("aria-describedby") ?? "");
	expect(warning?.textContent).toBe(BYPASS_WARNING);
});

test("the permission menu offers five modes and warns about Bypass before it is chosen", () => {
	draw();
	const menu = open("Permissions");
	expect(
		within(menu)
			.getAllByRole("menuitemradio")
			.map((item) => item.dataset.testid),
	).toEqual([
		"composer-mode-default",
		"composer-mode-acceptEdits",
		"composer-mode-plan",
		"composer-mode-auto",
		"composer-mode-bypassPermissions",
	]);
	const bypass = within(menu).getByRole("menuitemradio", {
		name: "Bypass permissions",
	});
	const line = document.getElementById(bypass.getAttribute("aria-describedby") ?? "");
	expect(line?.textContent).toBe(BYPASS_WARNING);
	expect(line?.querySelector(".pk-picker-warning svg")).not.toBeNull();
});

test("an unknown model shows as Default, and the pickers wait with their labels until settings arrive", () => {
	draw(null);
	expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
	expect(
		screen.getAllByTestId("composer-pick-waiting").map((pick) => pick.textContent),
	).toEqual(["Model", "Effort", "Permissions"]);
	rerender({ ...START, model: "some-new-model" });
	expect(picker("Model").textContent).toBe("Model Default");
	rerender({ ...START, model: "default" });
	expect(picker("Model").textContent).toBe("Model Default");
});

test("the narrow form hides words by CSS only: every button keeps its prefix in its name", () => {
	draw({ ...START, effort: "xhigh", mode: "bypassPermissions" });
	// No native title: it shows on mouse hover only (SPEC.md §25.8).
	expect(picker("Agent").hasAttribute("title")).toBe(false);
	expect(picker("Effort").textContent).toBe("Effort Extra high");
	expect(picker("Permissions").textContent).toBe("Permissions Bypass permissions");
	// The agent's short form is the visible part; the rest is its own hideable span.
	const value = picker("Agent").querySelector(".pk-picker-value");
	expect(value?.firstChild?.textContent).toBe("Claude");
	expect(value?.querySelector(".pk-picker-more")?.textContent).toBe(" Code");
	// Values with no short form are not split.
	expect(picker("Model").querySelector(".pk-picker-more")).toBeNull();
});

test("Codex is shown, reachable and not choosable, and the agent picker sends nothing", () => {
	draw();
	const menu = open("Agent");
	const codex = within(menu).getByRole("menuitemradio", { name: "Codex" });
	expect(codex.getAttribute("aria-disabled")).toBe("true");
	expect(
		document.getElementById(codex.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Coming soon.");
	fireEvent.click(codex);
	expect(screen.getByRole("menu", { name: /^Agent / })).toBeTruthy();
	fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Claude Code" }));
	expect(asked).toEqual([]);
	expect(picker("Agent").textContent).toBe("Agent Claude Code");
});

test("picking from the keyboard sends the change and closes the menu", () => {
	draw();
	const menu = open("Model");
	fireEvent.keyDown(within(menu).getByRole("menuitemradio", { name: "Opus" }), {
		key: "Enter",
	});
	expect(asked).toEqual([{ model: "opus" }]);
	expect(screen.queryByRole("menu")).toBeNull();
});

/** The host reports session rules, as after an Always allow. */
function holdRules(rules: { rule: string; description: string }[]) {
	const sessionId = "11111111-1111-4111-8111-111111111111";
	act(() => {
		store.getState().receive(
			JSON.stringify({
				type: "snapshot",
				sessionId,
				seq: 0,
				cards: [],
				turnRunning: false,
				truncated: false,
			}),
		);
		store
			.getState()
			.receive(JSON.stringify({ type: "rules", sessionId, seq: 1, rules }));
	});
}

test("Ask says some actions run without asking only while session rules are held", () => {
	draw();
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	holdRules([{ rule: "Bash(sed:*)", description: '"sed" commands in this session' }]);
	const hint = screen.getByText(ASK_RULES_HINT);
	expect(picker("Permissions").getAttribute("aria-describedby")).toBe(hint.id);
	// Another mode says what it does on its own.
	rerender({ ...START, mode: "auto" });
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	rerender(START);
	expect(screen.getByText(ASK_RULES_HINT)).toBeTruthy();
});

test("Ask with no session rules shows no hint", () => {
	draw();
	holdRules([]);
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	expect(picker("Permissions").getAttribute("aria-describedby")).toBeNull();
});

test("a picker's tooltip gives the full label on keyboard focus and describes nothing", async () => {
	draw({ ...START, effort: "xhigh", mode: "bypassPermissions" });
	const effort = picker("Effort");
	act(() => effort.focus());
	await screen.findByText("Effort Extra high", { selector: ".pk-tooltip" });
	// The name already says it; a description would be read twice.
	expect(describedText(effort)).toBe("");
	// A picker with a description of its own keeps only that one.
	const mode = picker("Permissions");
	act(() => mode.focus());
	await screen.findByText("Permissions Bypass permissions", {
		selector: ".pk-tooltip",
	});
	expect(describedText(mode)).toBe(BYPASS_WARNING);
});

test("each menu opens with a visible heading naming what it sets", () => {
	draw();
	for (const name of ["Agent", "Model", "Effort", "Permissions"]) {
		const menu = open(name);
		expect(menu.firstElementChild?.textContent).toBe(name);
		fireEvent.keyDown(menu, { key: "Escape" });
	}
});
