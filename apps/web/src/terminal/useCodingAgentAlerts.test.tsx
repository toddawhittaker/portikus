import type { CodingAgentTerminal, Project } from "@portikus/contracts";
import type { ToastProps } from "@portikus/ui";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStatusStore } from "./codingAgentStatus.js";
import { useCodingAgentAlerts } from "./useCodingAgentAlerts.js";

// SPEC.md §8.5, §10.8, §25.8: agent alerts are unrecorded toasts, and the
// desktop offer is made once per page load.
const shown: { props: ToastProps; remove: ReturnType<typeof vi.fn> }[] = [];
const navigate = vi.fn(async () => {});
const notify = vi.fn();
let setting = "ask";
let supported = true;
let permission: NotificationPermission = "default";

vi.mock("@portikus/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@portikus/ui")>()),
	useToast: () => ({
		show: (props: ToastProps) => {
			const remove = vi.fn();
			shown.push({ props, remove });
			return remove;
		},
	}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../editor/settingsQueries.js", () => ({
	useEditorSettings: () => ({ data: { agentNotifications: setting } }),
}));
vi.mock("../notifications/desktopSupport.js", () => ({
	desktopSupported: () => supported,
	desktopPermission: () => permission,
}));
vi.mock("../notifications/desktopNotify.js", () => ({
	notifyAgentAlert: (...args: unknown[]) => notify(...args),
	PermissionOffer: ({ onAnswered }: { onAnswered: () => void }) => (
		<button type="button" onClick={onAnswered}>
			Answer offer
		</button>
	),
}));

const HERE = "11111111-1111-4111-8111-111111111111";
const ELSE = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";
const SINCE = "2026-11-01T12:00:00.000Z";
const PROJECTS = [{ id: ELSE, name: "Other work" }] as Project[];

function term(
	terminalId: string,
	state: CodingAgentTerminal["state"],
	projectId = HERE,
): CodingAgentTerminal {
	return { terminalId, projectId, agent: "claude", state, since: SINCE };
}

/** A work area with one selected tab, or none. */
function workArea(withTab: boolean) {
	const main = document.createElement("main");
	main.tabIndex = -1;
	if (withTab) {
		const tab = document.createElement("button");
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", "true");
		main.append(tab);
	}
	document.body.append(main);
	return main;
}

/** The page is in front only when `focused.now` says so; otherwise every stop is news. */
function setup(withTab = true) {
	const focused = { now: false };
	const store = createAgentStatusStore(() => focused.now);
	const main = workArea(withTab);
	const hook = renderHook(() =>
		useCodingAgentAlerts(store, "w1", HERE, PROJECTS, { current: main }),
	);
	const feed = (terminals: CodingAgentTerminal[], initial = false) =>
		act(() => hook.result.current(terminals, initial));
	const look = (ids: string[]) => {
		focused.now = ids.length > 0;
		act(() => store.setViewing(ids));
	};
	return { main, feed, look };
}

/** Whether the toast at `index` carries the desktop notification offer. */
function hasOffer(index: number) {
	return shown[index]?.props.onDismiss !== undefined;
}

/** Render the actions of the toast at `index`. */
function actionsOf(index: number) {
	render(<div>{shown[index]?.props.actions}</div>);
}

beforeEach(() => {
	shown.length = 0;
	navigate.mockClear();
	notify.mockClear();
	setting = "ask";
	supported = true;
	permission = "default";
	document.body.innerHTML = "";
});

describe("raising alerts", () => {
	it("treats the first list as a baseline", () => {
		const { feed } = setup();
		feed([term(T1, "finished")], true);
		expect(shown).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("shows an unrecorded toast and asks for a desktop notification", () => {
		setting = "on";
		const { feed } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "needs-input")]);
		expect(shown).toHaveLength(1);
		expect(shown[0]?.props.title).toBe("Claude Code needs your input");
		expect(shown[0]?.props.unrecorded).toBe(true);
		expect(shown[0]?.props.persistent).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			terminalId: T1,
			state: "needs-input",
		});
	});

	it("names the project only for an agent in another one", () => {
		setting = "on";
		const { feed } = setup();
		feed([term(T1, "working"), term(T2, "working", ELSE)], true);
		feed([term(T1, "finished"), term(T2, "finished", ELSE)]);
		expect(shown[0]?.props.children).toBeUndefined();
		expect(shown[0]?.props.actions).toBeUndefined();
		expect(shown[1]?.props.children).toBe("In Other work");
	});

	it("takes the toast away when the student looks at that terminal", () => {
		setting = "on";
		const { feed, look } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "finished")]);
		expect(shown[0]?.remove).not.toHaveBeenCalled();
		look([T1]);
		expect(shown[0]?.remove).toHaveBeenCalledTimes(1);
	});

	it("replaces the older toast for the same terminal", () => {
		setting = "on";
		const { feed } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "needs-input")]);
		feed([term(T1, "finished")]);
		expect(shown).toHaveLength(2);
		expect(shown[0]?.remove).toHaveBeenCalledTimes(1);
	});
});

describe("staying on screen", () => {
	it("keeps every agent toast until seen or dismissed, with or without the offer", () => {
		const { feed } = setup();
		feed([term(T1, "working"), term(T2, "working")], true);
		feed([term(T1, "finished"), term(T2, "needs-input")]);
		expect(shown).toHaveLength(2);
		for (const t of shown) expect(t.props.persistent).toBe(true);
		setting = "off";
		feed([term(T1, "needs-input"), term(T2, "finished")]);
		expect(shown[2]?.props.persistent).toBe(true);
		expect(shown[3]?.props.persistent).toBe(true);
	});

	it("is removed on seen, and a replaced toast is removed", () => {
		const { feed, look } = setup();
		feed([term(T1, "working"), term(T2, "working")], true);
		feed([term(T1, "finished"), term(T2, "finished")]);
		feed([term(T1, "needs-input"), term(T2, "finished")]);
		expect(shown[0]?.remove).toHaveBeenCalledTimes(1);
		look([T2]);
		expect(shown[1]?.remove).toHaveBeenCalledTimes(1);
	});
});

describe("the desktop notification offer", () => {
	it("is offered only when it will show", () => {
		const cases = [
			["the setting is on", () => (setting = "on"), false],
			["the browser has no Notification", () => (supported = false), false],
			["the browser blocked them", () => (permission = "denied"), false],
			["nothing stands in the way", () => {}, true],
		] as const;
		for (const [name, arrange, expected] of cases) {
			shown.length = 0;
			setting = "ask";
			supported = true;
			permission = "default";
			arrange();
			const { feed } = setup();
			feed([term(T1, "working")], true);
			feed([term(T1, "finished")]);
			expect(hasOffer(0), name).toBe(expected);
		}
	});

	it("goes on one toast at a time", () => {
		const { feed } = setup();
		feed([term(T1, "working"), term(T2, "working")], true);
		feed([term(T1, "finished"), term(T2, "finished")]);
		expect(hasOffer(0)).toBe(true);
		expect(hasOffer(1)).toBe(false);
	});

	it("answering removes the toast and focuses the selected tab", () => {
		const { feed, main } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "finished")]);
		actionsOf(0);
		fireEvent.click(screen.getByRole("button", { name: "Answer offer" }));
		expect(shown[0]?.remove).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(main.querySelector('[role="tab"]'));
		// Answered: no later toast carries it.
		feed([term(T1, "needs-input")]);
		expect(hasOffer(1)).toBe(false);
	});

	it("answering focuses the work area when no tab is selected", () => {
		const { feed, main } = setup(false);
		feed([term(T1, "working")], true);
		feed([term(T1, "finished")]);
		actionsOf(0);
		fireEvent.click(screen.getByRole("button", { name: "Answer offer" }));
		expect(document.activeElement).toBe(main);
	});

	it("is carried on by a newer toast that replaces it", () => {
		const { feed } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "needs-input")]);
		feed([term(T1, "finished")]);
		expect(hasOffer(0)).toBe(true);
		expect(hasOffer(1)).toBe(true);
	});

	it("is carried on after the toast holding it is removed unanswered", () => {
		const { feed, look } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "finished")]);
		look([T1]);
		look([]);
		feed([term(T1, "needs-input")]);
		expect(hasOffer(1)).toBe(true);
	});

	it("is not made again once the student dismissed it", () => {
		const { feed } = setup();
		feed([term(T1, "working")], true);
		feed([term(T1, "finished")]);
		act(() => shown[0]?.props.onDismiss?.());
		feed([term(T1, "needs-input")]);
		expect(hasOffer(1)).toBe(false);
		expect(shown[1]?.props.onDismiss).toBeUndefined();
	});
});

describe("Open project", () => {
	it("removes the toast, navigates and focuses the work area", async () => {
		setting = "on";
		const { feed, main } = setup();
		feed([term(T1, "working", ELSE)], true);
		feed([term(T1, "finished", ELSE)]);
		actionsOf(0);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open project" }));
		});
		expect(shown[0]?.remove).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith({
			to: "/workspaces/$id/projects/$projectId",
			params: { id: "w1", projectId: ELSE },
		});
		expect(document.activeElement).toBe(main);
	});

	it("is also what clicking a desktop notification does", async () => {
		setting = "on";
		const { feed, main } = setup();
		feed([term(T1, "working", ELSE)], true);
		feed([term(T1, "finished", ELSE)]);
		const onOpen = notify.mock.calls[0]?.[1] as () => void;
		await act(async () => onOpen());
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(main);
	});
});
