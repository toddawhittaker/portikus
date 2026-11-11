import { CHAT_START_SETTINGS, type ChatModelInfo } from "@portikus/contracts";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { ASK_RULES_HINT, BYPASS_WARNING, ComposerPickers } from "./ComposerPickers.js";
import { type ChatState, type ChatStore, createChatStore } from "./chatStore.js";
import { installFakeSpeech, removeFakeSpeech } from "./speechTesting.js";

type Settings = NonNullable<ChatState["settings"]>;

const START: Settings = { agent: "claude", ...CHAT_START_SETTINGS, model: "sonnet" };

/** The list Claude Code gives: families with a short name, and pinned versions. */
function row(
	value: string,
	displayName: string,
	resolvedModel = value,
	supportsAutoMode = true,
): ChatModelInfo {
	return {
		value,
		displayName,
		resolvedModel,
		description: "A model",
		supportsAutoMode,
	};
}
const MODELS: ChatModelInfo[] = [
	row("default", "Default (recommended)", "claude-opus-5-5"),
	row("opus", "Opus 5.5", "claude-opus-5-5"),
	row("fable", "Fable 5.2", "claude-fable-5-2"),
	row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
	row("haiku", "Haiku 5.5", "claude-haiku-5-5"),
	row("claude-opus-4-7", "Opus 4.7"),
	row("claude-opus-4-8", "Opus 4.8"),
	row("claude-opus-5", "Opus 5"),
	row("claude-haiku-4-5-20251001", "Haiku 4.5", "claude-haiku-4-5-20251001", false),
];

let asked: unknown[];
let accept: boolean;
let announced: string[];
let switched: boolean[];
let readingAloud: boolean;
let panelOpen: boolean;
let toggled: boolean[];
let store: ChatStore;
let rerender: (
	settings: ChatState["settings"],
	lastError?: ChatState["lastError"],
) => void;

function draw(
	settings: ChatState["settings"] = START,
	models: ChatModelInfo[] = MODELS,
) {
	store.setState({ settings, models });
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
				readAloud={{ on: readingAloud, set: (next) => switched.push(next) }}
				open={panelOpen}
				onOpenChange={(next) => toggled.push(next)}
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
	switched = [];
	readingAloud = false;
	panelOpen = true;
	toggled = [];
});

test("each picker is a menu button named by its label and the value shown", () => {
	draw({ ...START, model: "opus", effort: "xhigh", mode: "plan" });
	expect(picker("Agent").textContent).toBe("Agent Claude Code");
	expect(picker("Model").textContent).toBe("Model Opus");
	expect(picker("Effort").textContent).toBe("Effort Extra high");
	expect(picker("Permissions").textContent).toBe("Permissions Plan");
	expect(picker("Version").textContent).toBe("Version Latest (5.5)");
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
	// The marker is a description, so the choice is still named just "Medium".
	const start = within(menu).getByRole("menuitemradio", { name: "Medium" });
	expect(start.querySelector(".pk-picker-default")?.textContent).toBe("Default");
	expect(menu.querySelectorAll(".pk-picker-default")).toHaveLength(1);
	expect(
		document.getElementById(start.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Default. Thinks a little before acting.");
});

test("every choice says what it is for in a line of its own", () => {
	draw();
	for (const name of ["Agent", "Model", "Version", "Effort", "Permissions"]) {
		const menu = open(name);
		for (const item of within(menu).getAllByRole("menuitemradio")) {
			const line = document.getElementById(item.getAttribute("aria-describedby") ?? "");
			expect(line?.textContent?.length, item.textContent ?? "").toBeGreaterThan(5);
		}
		fireEvent.keyDown(menu, { key: "Escape" });
	}
});

test("each change asks for exactly that and shows it while the host has not answered", () => {
	draw({ ...START, model: "opus" });
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
	choose("Effort", "Medium");
	choose("Permissions", "Auto");
	choose("Version", "Latest (5.5)");
	expect(asked).toEqual([]);
});

test("a change that could not be sent is not shown", () => {
	accept = false;
	draw();
	choose("Effort", "Low");
	expect(asked).toEqual([{ effort: "low" }]);
	expect(picker("Effort").textContent).toBe("Effort Medium");
});

test("a change the host refuses goes back and is announced", () => {
	draw();
	choose("Effort", "Max");
	expect(picker("Effort").textContent).toBe("Effort Max");
	rerender(START, { seq: 7, message: "This model has no Max effort." });
	expect(picker("Effort").textContent).toBe("Effort Medium");
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

test("the pickers wait with their labels until settings arrive", () => {
	draw(null);
	expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
	expect(
		screen.getAllByTestId("composer-pick-waiting").map((pick) => pick.textContent),
	).toEqual(["Model", "Effort", "Permissions"]);
	rerender({ ...START, model: "default" });
	expect(picker("Model").textContent).toBe("Model Default");
	// Default has no versions to choose between.
	expect(screen.queryByRole("button", { name: /^Version / })).toBeNull();
});

test("the Options button summarises the settings and says whether the panel is open", () => {
	panelOpen = false;
	draw({ ...START, model: "opus", effort: "xhigh", mode: "plan" });
	const options = screen.getByTestId("composer-options");
	expect(options.textContent).toBe("Chat options: Opus \u00b7 Extra high \u00b7 Plan");
	expect(options.getAttribute("aria-expanded")).toBe("false");
	const panel = screen.getByTestId("composer-picks");
	expect(options.getAttribute("aria-controls")).toBe(panel.id);
	expect(panel.hidden).toBe(true);
	fireEvent.click(options);
	expect(toggled).toEqual([true]);
});

test("the summary names the agent for the default model, and Bypass shows on it", () => {
	panelOpen = false;
	draw({ ...START, model: "default", mode: "bypassPermissions" });
	const options = screen.getByTestId("composer-options");
	expect(options.textContent).toBe(
		"Chat options: Claude \u00b7 Medium \u00b7 Bypass permissions",
	);
	expect(options.classList.contains("is-warning")).toBe(true);
});

test("Escape in the open panel closes it and puts focus on the Options button", () => {
	draw();
	const effort = picker("Effort");
	act(() => effort.focus());
	fireEvent.keyDown(effort, { key: "Escape" });
	expect(toggled).toEqual([false]);
	expect(document.activeElement).toBe(screen.getByTestId("composer-options"));
});

test("a press outside the open panel closes it; a press inside does not", () => {
	draw();
	fireEvent.pointerDown(screen.getByText("Chat options", { selector: "legend" }));
	expect(toggled).toEqual([]);
	fireEvent.pointerDown(document.body);
	expect(toggled).toEqual([false]);
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
	const ask = { ...START, mode: "default" } as const;
	draw(ask);
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	holdRules([{ rule: "Bash(sed:*)", description: '"sed" commands in this session' }]);
	const hint = screen.getByText(ASK_RULES_HINT);
	expect(picker("Permissions").getAttribute("aria-describedby")).toBe(hint.id);
	// Another mode says what it does on its own.
	rerender({ ...ask, mode: "auto" });
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	rerender(ask);
	expect(screen.getByText(ASK_RULES_HINT)).toBeTruthy();
});

test("Ask with no session rules shows no hint", () => {
	draw();
	holdRules([]);
	expect(screen.queryByText(ASK_RULES_HINT)).toBeNull();
	expect(picker("Permissions").getAttribute("aria-describedby")).toBeNull();
});

test("each menu opens with a visible heading naming what it sets", () => {
	draw();
	for (const name of ["Agent", "Model", "Effort", "Permissions"]) {
		const menu = open(name);
		expect(menu.firstElementChild?.textContent).toBe(name);
		fireEvent.keyDown(menu, { key: "Escape" });
	}
});

function readAloudSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: "Read replies aloud" });
}

test("the Read replies aloud switch shows its state and flips on a click or Space", () => {
	installFakeSpeech();
	try {
		draw();
		const toggle = readAloudSwitch();
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(toggle.textContent).toContain("Off");
		fireEvent.click(toggle);
		expect(switched).toEqual([true]);
	} finally {
		removeFakeSpeech();
	}
});

test("the switch reads On when the project reads aloud", () => {
	installFakeSpeech();
	try {
		readingAloud = true;
		draw();
		expect(readAloudSwitch().getAttribute("aria-checked")).toBe("true");
		expect(readAloudSwitch().textContent).toContain("On");
		fireEvent.click(readAloudSwitch());
		expect(switched).toEqual([false]);
	} finally {
		removeFakeSpeech();
	}
});

test("the switch is there before the host reports settings, and is hidden without speech", () => {
	installFakeSpeech();
	try {
		draw(null);
		expect(readAloudSwitch()).toBeTruthy();
	} finally {
		removeFakeSpeech();
	}
	cleanup();
	draw();
	expect(screen.queryByRole("switch")).toBeNull();
});

test("the Version picker defaults to Latest with the version it means, and lists pinned versions newest first", () => {
	draw({ ...START, model: "opus" });
	expect(picker("Version").textContent).toBe("Version Latest (5.5)");
	const menu = open("Version");
	const items = within(menu).getAllByRole("menuitemradio");
	expect(items[0]?.textContent).toMatch(/^Latest \(5\.5\)/);
	expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
		"true",
		"false",
		"false",
		"false",
	]);
	expect(items.map((item) => item.dataset.testid)).toEqual([
		"composer-version-opus",
		"composer-version-claude-opus-5",
		"composer-version-claude-opus-4-8",
		"composer-version-claude-opus-4-7",
	]);
});

test("choosing a version asks for that exact model, and Latest asks for the short name", () => {
	draw({ ...START, model: "opus" });
	choose("Version", "4.8");
	expect(asked).toEqual([{ model: "claude-opus-4-8" }]);
	expect(picker("Version").textContent).toBe("Version 4.8");
	expect(screen.getByTestId("composer-options").textContent).toBe(
		"Chat options: Opus 4.8 \u00b7 Medium \u00b7 Auto",
	);
	rerender({ ...START, model: "claude-opus-4-8" });
	expect(picker("Model").textContent).toBe("Model Opus");
	choose("Version", "Latest (5.5)");
	expect(asked.at(-1)).toEqual({ model: "opus" });
});

test("a full ID that a short name resolves to shows as Latest, and a suffix is ignored", () => {
	draw({ ...START, model: "claude-opus-5-5[1m]" });
	expect(picker("Model").textContent).toBe("Model Opus");
	expect(picker("Version").textContent).toBe("Version Latest (5.5)");
});

test("changing the model goes to that family's Latest", () => {
	draw({ ...START, model: "claude-opus-4-8" });
	choose("Model", "Fable");
	expect(asked).toEqual([{ model: "fable" }]);
	expect(picker("Version").textContent).toBe("Version Latest (5.2)");
});

test("the Model menu lists Default and each family from the list, with no pinned versions", () => {
	draw();
	const menu = open("Model");
	expect(
		within(menu)
			.getAllByRole("menuitemradio")
			.map((item) => item.dataset.testid),
	).toEqual([
		"composer-model-default",
		"composer-model-opus",
		"composer-model-fable",
		"composer-model-sonnet",
		"composer-model-haiku",
	]);
});

test("before the list arrives the picker shows Default and the current model, and no Version", () => {
	draw({ ...START, model: "fable" }, []);
	expect(picker("Model").textContent).toBe("Model Fable");
	expect(screen.queryByRole("button", { name: /^Version / })).toBeNull();
	const menu = open("Model");
	expect(
		within(menu)
			.getAllByRole("menuitemradio")
			.map((item) => item.dataset.testid),
	).toEqual(["composer-model-default", "composer-model-fable"]);
});

test("on a model without Auto the start mode is Ask", () => {
	draw({ ...START, model: "claude-haiku-4-5-20251001", mode: "default" }, [
		row("default", "Default (recommended)", "claude-opus-5-5"),
		row("haiku", "Haiku 5.5", "claude-haiku-5-5", false),
		row("claude-haiku-4-5-20251001", "Haiku 4.5", "claude-haiku-4-5-20251001", false),
	]);
	// The family's Latest (haiku) does not support Auto; the pinned row is the current one,
	// whose own support decides the start mode.
	const mode = picker("Permissions");
	expect(mode.className).not.toContain("is-changed");
});

test("Read replies aloud is the last item of the panel, after Model and Version", () => {
	installFakeSpeech();
	try {
		draw();
		const names = Array.from(
			screen.getByTestId("composer-picks").querySelectorAll("button"),
		).map((button) => button.getAttribute("data-testid"));
		expect(names).toEqual([
			"composer-agent",
			"composer-model",
			"composer-version",
			"composer-effort",
			"composer-mode",
			"composer-read-aloud",
		]);
	} finally {
		removeFakeSpeech();
	}
});
