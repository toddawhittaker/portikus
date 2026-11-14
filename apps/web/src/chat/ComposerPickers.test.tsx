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
import { ASK_RULES_HINT, ComposerPickers } from "./ComposerPickers.js";
import { type ChatState, type ChatStore, createChatStore } from "./chatStore.js";
import { installFakeSpeech, removeFakeSpeech } from "./speechTesting.js";

type Settings = NonNullable<ChatState["settings"]>;

const BYPASS_WARNING =
	"Bypass permissions lets Claude run every tool without asking you first.";

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
let mcpOpen: boolean;
let mcpToggled: boolean[];
let agentsAsked: string[];
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
				mcpOpen={mcpOpen}
				onMcpOpenChange={(next) => mcpToggled.push(next)}
				onSwitchAgent={(agent) => agentsAsked.push(agent)}
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
	mcpOpen = false;
	mcpToggled = [];
	agentsAsked = [];
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

/** Claude Code's modes as its host lists them. */
const CLAUDE_MODES = [
	["default", "Ask", "Asks before it edits files or runs commands."],
	["acceptEdits", "Accept edits", "Edits files on its own. Asks before commands."],
	["plan", "Plan", "Reads and plans. Changes nothing."],
	["auto", "Auto", "Runs what it judges safe. Asks about the rest."],
	["bypassPermissions", "Bypass permissions", BYPASS_WARNING],
].map(([id = "", label = "", description = ""]) => ({
	id,
	label,
	description,
	warning: id === "bypassPermissions",
	plan: id === "plan",
}));

test("every choice says what it is for in a line of its own", () => {
	store.setState({ modes: CLAUDE_MODES });
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

test("a host that lists no modes still gets Claude's five, and Bypass warns before it is chosen", () => {
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

function description(item: HTMLElement): string | undefined {
	return (
		document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ??
		undefined
	);
}

test("in an empty chat Codex can be chosen, and choosing it asks to swap the agent, not to set anything", () => {
	store.setState({ loaded: true });
	draw();
	const menu = open("Agent");
	const codex = within(menu).getByRole("menuitemradio", { name: "Codex" });
	expect(codex.getAttribute("aria-disabled")).toBeNull();
	expect(description(codex)).toBe("OpenAI's coding agent.");
	fireEvent.click(codex);
	expect(agentsAsked).toEqual(["codex"]);
	expect(asked).toEqual([]);
});

test("in a chat with history the other agent stays reachable, cannot be chosen, and says how to use it", () => {
	store.setState({
		loaded: true,
		items: [
			{
				kind: "message",
				key: "message:m1",
				id: "m1",
				role: "user",
				markdown: "Hi",
				attachments: [],
				streaming: false,
				turnId: null,
			},
		],
	});
	draw();
	const menu = open("Agent");
	const codex = within(menu).getByRole("menuitemradio", { name: "Codex" });
	expect(codex.getAttribute("aria-disabled")).toBe("true");
	expect(description(codex)).toBe(
		"To use Codex now, start a new chat from the New tab menu.",
	);
	fireEvent.click(codex);
	expect(agentsAsked).toEqual([]);
	// Choosing the agent already in use asks for nothing.
	fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Claude Code" }));
	expect(agentsAsked).toEqual([]);
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

test("Read replies aloud heads the panel beside its title, then the settings in order", () => {
	installFakeSpeech();
	try {
		draw();
		const panel = screen.getByTestId("composer-picks");
		const names = Array.from(panel.querySelectorAll("button")).map((button) =>
			button.getAttribute("data-testid"),
		);
		expect(names).toEqual([
			"composer-read-aloud",
			"composer-agent",
			"composer-model",
			"composer-version",
			"composer-effort",
			"composer-mode",
			"composer-mcp",
		]);
		// The switch sits in the heading row, not among the settings.
		expect(panel.querySelector("legend")?.nextElementSibling).toBe(
			screen.getByTestId("composer-read-aloud"),
		);
		// Model and Version are one unit, so they wrap together.
		expect(screen.getByTestId("composer-model").parentElement).toBe(
			screen.getByTestId("composer-version").parentElement,
		);
	} finally {
		removeFakeSpeech();
	}
});

/** Codex's list: no default row and no pinned versions; each model lists its efforts. */
function codexRow(
	value: string,
	displayName: string,
	efforts: string[],
): ChatModelInfo {
	return {
		value,
		resolvedModel: value,
		displayName,
		description: `${displayName} model`,
		supportsAutoMode: true,
		efforts,
		defaultEffort: "medium",
	};
}
const CODEX_MODELS: ChatModelInfo[] = [
	codexRow("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh", "ultra"]),
	codexRow("gpt-5.4-mini", "GPT-5.4 mini", ["low", "medium", "high"]),
];
const CODEX_MODES = [
	{
		id: "untrusted",
		label: "Ask",
		description: "Asks first.",
		warning: false,
		plan: false,
	},
	{ id: "plan", label: "Plan", description: "Plans only.", warning: false, plan: true },
	{
		id: "onRequest",
		label: "Auto",
		description: "Works alone.",
		warning: false,
		plan: false,
	},
	{
		id: "fullAccess",
		label: "Full access",
		description: "Full access lets Codex run every command without asking you first.",
		warning: true,
		plan: false,
	},
];
const CODEX: Settings = {
	agent: "codex",
	model: "gpt-5.5",
	effort: "medium",
	mode: "onRequest",
};

function drawCodex(settings: Settings = CODEX) {
	store.setState({ modes: CODEX_MODES });
	draw(settings, CODEX_MODELS);
}

/** Each row's visible name, without the line that describes it. */
function rows(menu: HTMLElement): string[] {
	return within(menu)
		.getAllByRole("menuitemradio")
		.map((item) => (item.textContent ?? "").replace(description(item) ?? "", ""));
}

test("a Codex chat names the agent, lists the models by their own names, and has no Version picker", () => {
	drawCodex();
	expect(picker("Agent").textContent).toBe("Agent Codex");
	expect(picker("Model").textContent).toBe("Model GPT-5.5");
	expect(screen.queryByTestId("composer-version")).toBeNull();
	// No Default row: Codex has none of its own.
	expect(rows(open("Model"))).toEqual(["GPT-5.5", "GPT-5.4 mini"]);
	expect(screen.getByTestId("composer-options").textContent).toContain(
		"GPT-5.5 · Medium · Auto",
	);
});

test("the Effort menu lists the model's own efforts, in Portikus's words where known and as written otherwise", () => {
	drawCodex();
	const menu = open("Effort");
	expect(rows(menu)).toEqual(["Low", "Medium Default", "High", "Extra high", "ultra"]);
	fireEvent.click(within(menu).getByRole("menuitemradio", { name: "ultra" }));
	expect(asked).toEqual([{ effort: "ultra" }]);
	expect(picker("Effort").textContent).toBe("Effort ultra");
	expect(picker("Effort").classList.contains("is-changed")).toBe(true);
});

test("a model's own default effort is the one marked Default, and another reads as changed", () => {
	drawCodex({ ...CODEX, model: "gpt-5.4-mini", effort: "high" });
	expect(picker("Effort").classList.contains("is-changed")).toBe(true);
	expect(rows(open("Effort"))).toEqual(["Low", "Medium Default", "High"]);
});

test("a Claude model with no efforts listed keeps all five", () => {
	draw();
	expect(rows(open("Effort"))).toEqual([
		"Low",
		"Medium Default",
		"High",
		"Extra high",
		"Max",
	]);
});

test("the Permissions menu draws the host's modes, Auto as Codex's start, and warns about Full access", () => {
	drawCodex();
	const menu = open("Permissions");
	expect(rows(menu)).toEqual(["Ask", "Plan", "Auto Default", "Full access"]);
	const full = within(menu).getByRole("menuitemradio", { name: "Full access" });
	expect(description(full)).toBe(
		"Full access lets Codex run every command without asking you first.",
	);
	expect(full.querySelector(".pk-picker-warning")).not.toBeNull();
	fireEvent.click(full);
	expect(asked).toEqual([{ mode: "fullAccess" }]);
	const mode = picker("Permissions");
	expect(mode.classList.contains("is-warning")).toBe(true);
	expect(mode.getAttribute("aria-describedby")).toBe("bypass-warning");
	expect(screen.getByTestId("composer-options").classList.contains("is-warning")).toBe(
		true,
	);
});

test("a host's own words for Claude's modes replace Portikus's", () => {
	store.setState({
		modes: [
			{
				id: "default",
				label: "Ask first",
				description: "Asks.",
				warning: false,
				plan: false,
			},
			{ id: "auto", label: "Auto", description: "Runs.", warning: false, plan: false },
		],
	});
	draw();
	expect(rows(open("Permissions"))).toEqual(["Ask first", "Auto Default"]);
});

test("the MCP servers field sums up the list and discloses each server's state", () => {
	store.setState({
		mcp: [
			{ name: "github", status: "connected" },
			{ name: "docs", status: "needsAuth" },
			{ name: "db", status: "failed" },
		],
	});
	drawCodex();
	const field = screen.getByTestId("composer-mcp");
	expect(field.textContent).toBe("MCP servers 1 of 3 connected");
	expect(field.getAttribute("aria-expanded")).toBe("false");
	const list = screen.getByTestId("composer-mcp-list");
	expect(list.hidden).toBe(true);
	expect(field.getAttribute("aria-controls")).toBe(list.id);
	fireEvent.click(field);
	expect(mcpToggled).toEqual([true]);
});

test("an open MCP list names each server with its state in words, and where they are managed", () => {
	mcpOpen = true;
	store.setState({
		mcp: [
			{ name: "github", status: "connected" },
			{ name: "docs", status: "needsAuth" },
			{ name: "db", status: "failed" },
			{ name: "local", status: "starting" },
			{ name: "old", status: "disabled" },
		],
	});
	drawCodex();
	const list = screen.getByRole("region", { name: "MCP servers" });
	expect(
		within(list)
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual([
		"github Connected",
		"docs Needs sign-in",
		"db Failed",
		"local Starting",
		"old Disabled",
	]);
	expect(list.textContent).toContain(
		"Servers are managed in a terminal, with codex mcp.",
	);
	expect(screen.getByTestId("composer-mcp").getAttribute("aria-expanded")).toBe("true");
});

test("with no MCP servers the field says None and the list says none are set up", () => {
	mcpOpen = true;
	draw();
	expect(screen.getByTestId("composer-mcp").textContent).toBe("MCP servers None");
	const list = screen.getByRole("region", { name: "MCP servers" });
	expect(list.textContent).toContain("No MCP servers are set up.");
	expect(list.textContent).toContain("with claude mcp.");
});
