import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetStubs, stubSettings } from "../settings/test-data.js";
import { renderWithQuery } from "../test-utils.js";
import { notifyAgentAlert, PermissionOffer } from "./desktopNotify.js";

// SPEC.md section 25.8: desktop notifications are opt-in and name no project.
const navigate = vi.fn();
vi.mock("../router.js", () => ({
	router: { navigate: (arg: unknown) => navigate(arg) },
}));

const ALERT = {
	agent: "claude",
	state: "needs-input",
	workspaceId: "w1",
	projectId: "p1",
	terminalId: "t1",
} as const;

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static requestPermission = vi.fn(async () => FakeNotification.permission);
	static shown: FakeNotification[] = [];
	onclick: (() => void) | null = null;
	close = vi.fn();
	constructor(
		readonly title: string,
		readonly options: NotificationOptions,
	) {
		FakeNotification.shown.push(this);
	}
}

function pageState(hidden: boolean, focused: boolean) {
	vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
	vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

function stored(agentNotifications: "ask" | "on" | "off") {
	return stubSettings({ ...EDITOR_SETTINGS_DEFAULTS, agentNotifications });
}

beforeEach(() => {
	FakeNotification.permission = "granted";
	FakeNotification.shown = [];
	FakeNotification.requestPermission.mockClear();
	navigate.mockClear();
	vi.stubGlobal("Notification", FakeNotification);
	pageState(true, false);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	resetStubs();
});

test("a hidden page gets a notification naming only the agent and the state", async () => {
	stored("on");
	notifyAgentAlert(ALERT);
	await waitFor(() => expect(FakeNotification.shown).toHaveLength(1));
	const [shown] = FakeNotification.shown;
	expect(shown?.title).toBe("Portikus");
	expect(shown?.options.body).toBe("Claude Code needs your input");
	expect(shown?.options.tag).toBe("t1");
});

test("Codex finishing reads as such", async () => {
	stored("on");
	notifyAgentAlert({ ...ALERT, agent: "codex", state: "finished" });
	await waitFor(() => expect(FakeNotification.shown).toHaveLength(1));
	expect(FakeNotification.shown[0]?.options.body).toBe("Codex finished");
});

test("a visible page without focus still gets one", async () => {
	stored("on");
	pageState(false, false);
	notifyAgentAlert(ALERT);
	await waitFor(() => expect(FakeNotification.shown).toHaveLength(1));
});

test.each([
	["the page is in front", () => pageState(false, true), "on"],
	["the setting is off", () => {}, "off"],
	["the setting is still ask", () => {}, "ask"],
	[
		"the browser has not granted",
		() => {
			FakeNotification.permission = "default";
		},
		"on",
	],
	[
		"the browser has blocked them",
		() => {
			FakeNotification.permission = "denied";
		},
		"on",
	],
] as const)("nothing shows when %s", async (_name, arrange, setting) => {
	const writes = stored(setting);
	arrange();
	notifyAgentAlert(ALERT);
	// The settings read, if any, has time to land.
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(FakeNotification.shown).toHaveLength(0);
	expect(writes).toHaveLength(0);
});

test("nothing shows, and nothing breaks, when the browser has no Notification", () => {
	vi.stubGlobal("Notification", undefined);
	expect(() => notifyAgentAlert(ALERT)).not.toThrow();
});

test("clicking it focuses the window and opens that project", async () => {
	stored("on");
	const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
	notifyAgentAlert(ALERT);
	await waitFor(() => expect(FakeNotification.shown).toHaveLength(1));
	const [shown] = FakeNotification.shown;
	shown?.onclick?.();
	expect(focus).toHaveBeenCalled();
	expect(shown?.close).toHaveBeenCalled();
	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith({
			to: "/workspaces/$id/projects/$projectId",
			params: { id: "w1", projectId: "p1" },
		}),
	);
});

test("the offer asks the browser only when Turn on is clicked, then saves on", async () => {
	FakeNotification.permission = "default";
	FakeNotification.requestPermission.mockImplementation(async () => "granted");
	const writes = stored("ask");
	renderWithQuery(<PermissionOffer />);
	const turnOn = await screen.findByRole("button", {
		name: "Turn on desktop notifications",
	});
	expect(screen.getByRole("button", { name: "No thanks" })).toBeTruthy();
	expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
	fireEvent.click(turnOn);
	await waitFor(() => expect(writes).toEqual([{ body: { agentNotifications: "on" } }]));
	expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("button", { name: "No thanks" })).toBeNull();
});

test("a refused browser prompt saves off", async () => {
	FakeNotification.permission = "default";
	FakeNotification.requestPermission.mockImplementation(async () => "denied");
	const writes = stored("ask");
	renderWithQuery(<PermissionOffer />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Turn on desktop notifications" }),
	);
	await waitFor(() =>
		expect(writes).toEqual([{ body: { agentNotifications: "off" } }]),
	);
});

test("No thanks saves off without asking the browser", async () => {
	FakeNotification.permission = "default";
	const writes = stored("ask");
	renderWithQuery(<PermissionOffer />);
	fireEvent.click(await screen.findByRole("button", { name: "No thanks" }));
	await waitFor(() =>
		expect(writes).toEqual([{ body: { agentNotifications: "off" } }]),
	);
	expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
});

test.each([
	["the setting is on", "on", "default"],
	["the setting is off", "off", "default"],
	["the browser already granted", "ask", "granted"],
	["the browser already blocked", "ask", "denied"],
] as const)("the offer is empty when %s", async (_name, setting, permission) => {
	FakeNotification.permission = permission;
	const writes = stored(setting);
	renderWithQuery(<PermissionOffer />);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(document.body.querySelectorAll("button")).toHaveLength(0);
	expect(writes).toHaveLength(0);
});

test("the offer is empty when the browser has no Notification", async () => {
	vi.stubGlobal("Notification", undefined);
	stored("ask");
	renderWithQuery(<PermissionOffer />);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(document.body.querySelectorAll("button")).toHaveLength(0);
});
