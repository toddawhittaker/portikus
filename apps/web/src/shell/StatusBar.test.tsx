import type { Workspace } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import {
	json,
	openToggletip,
	renderWithQuery,
	stubFetch,
	WORKSPACE,
} from "../test-utils.js";
import { RightPaneContext } from "./rightPane.js";
import {
	MEMORY_ANNOUNCEMENT,
	StatusBar,
	UNVERIFIED_ANNOUNCEMENT,
	usageMeter,
} from "./StatusBar.js";
import { UNVERIFIED_EXPLANATION, type WorkspaceDialogMode } from "./WorkspaceDialog.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The page's side of the dialog state, as WorkspacePage holds it. */
function Bar({
	workspace,
	initial = "closed",
}: {
	workspace: Workspace | null;
	initial?: WorkspaceDialogMode;
}) {
	const [dialog, setDialog] = useState<WorkspaceDialogMode>(initial);
	return (
		<StatusBar
			workspaceId={WORKSPACE.id}
			project={undefined}
			workspace={workspace}
			dialog={dialog}
			onDialogChange={setDialog}
		/>
	);
}

function renderBar(
	workspace: Workspace | null = WORKSPACE,
	initial: WorkspaceDialogMode = "closed",
) {
	renderWithQuery(<Bar workspace={workspace} initial={initial} />);
}

/** Open the "Your workspace" dialog from the state button. */
function openStatus() {
	fireEvent.click(screen.getByTestId("workspace-status"));
}

test("the state is a button labelled with the workspace state, and the leave-terminal hint is gone", () => {
	renderBar();

	const button = screen.getByTestId("workspace-status");
	expect(button.tagName).toBe("BUTTON");
	expect(screen.getByTestId("workspace-state").textContent).toBe("Running");
	expect(screen.queryByText(/Leave terminal/)).toBeNull();
});

test("a stopped workspace is labelled Stopped", () => {
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });

	expect(screen.getByTestId("workspace-state").textContent).toBe("Stopped");
});

test("a verified state carries no unconfirmed marker", () => {
	renderBar();

	expect(screen.queryByTestId("workspace-state-unverified")).toBeNull();
});

test("an unverified state is marked unconfirmed, with the reason in its accessible name (SPEC.md §18.3)", () => {
	for (const state of ["running", "stopped", "error"] as const) {
		renderBar({ ...WORKSPACE, state, stateVerified: false });
		const marker = screen.getByTestId("workspace-state-unverified");
		expect(marker.className).toContain("pk-tone-warning");
		expect(marker.textContent).toContain("unconfirmed");
		const button = screen.getByRole("button", { name: /unconfirmed/ });
		expect(button.textContent).toContain(UNVERIFIED_EXPLANATION);
		cleanup();
	}
});

test("the state turning unconfirmed is announced in its own status region", () => {
	const client = createQueryClient();
	const wrap = (workspace: Workspace) => (
		<QueryClientProvider client={client}>
			<ToastProvider>
				<Bar workspace={workspace} />
			</ToastProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(wrap(WORKSPACE));
	const region = screen.getByTestId("state-unverified-announce");
	expect(region.getAttribute("role")).toBe("status");
	expect(region.textContent).toBe("");

	rerender(wrap({ ...WORKSPACE, stateVerified: false }));
	expect(screen.getByTestId("state-unverified-announce").textContent).toBe(
		UNVERIFIED_ANNOUNCEMENT,
	);
	expect(screen.getByTestId("workspace-state").textContent).not.toContain(
		"unconfirmed",
	);
});

test("the workspace dialog shows the unconfirmed warning beside the state", () => {
	renderBar();
	openStatus();
	expect(screen.queryByTestId("workspace-status-unverified")).toBeNull();
	cleanup();

	renderBar({ ...WORKSPACE, stateVerified: false });
	openStatus();
	const line = screen.getByTestId("workspace-status-unverified");
	expect(line.className).toContain("pk-tone-warning");
	expect(line.textContent).toBe(UNVERIFIED_EXPLANATION);
});

test("no workspace yet reads as Connecting", () => {
	renderBar(null);

	expect(screen.getByTestId("workspace-state").textContent).toBe("Connecting");
});

test("a running workspace offers restart and stop", () => {
	renderBar();
	openStatus();

	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
	expect(screen.getByTestId("workspace-restart")).toBeDefined();
	expect(screen.getByTestId("workspace-stop")).toBeDefined();
	expect(screen.queryByTestId("workspace-start")).toBeNull();
});

test("a stopped workspace offers start only", () => {
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-start")).toBeDefined();
	expect(screen.queryByTestId("workspace-stop")).toBeNull();
});

test("a workspace in transition shows it and disables the buttons", () => {
	renderBar({ ...WORKSPACE, state: "running", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-state").textContent).toBe("Stopping");
	expect(screen.getByTestId("workspace-transition").textContent).toBe(
		"Stopping your workspace.",
	);
	// Unavailable, but still focusable so focus is never dropped (Gate E).
	expect(screen.getByTestId("workspace-stop").getAttribute("aria-disabled")).toBe(
		"true",
	);
	expect(screen.getByTestId("workspace-restart").getAttribute("aria-disabled")).toBe(
		"true",
	);
	fireEvent.click(screen.getByTestId("workspace-stop"));
	expect(screen.queryByTestId("dialog-workspace-stop")).toBeNull();
});

test("the dialog keeps a status region mounted for transitions (Gate E)", () => {
	renderBar();
	openStatus();

	const region = screen.getByTestId("workspace-transition");
	expect(region.getAttribute("role")).toBe("status");
	expect(region.textContent).toBe("");
});

test("Start keeps focus while its request runs (Gate E)", async () => {
	let finish: (response: Response) => void = () => undefined;
	stubFetch((url) =>
		url.endsWith("/start")
			? // Held open so the button stays busy; stubFetch awaits the handler.
				(new Promise<Response>((resolve) => {
					finish = resolve;
				}) as unknown as Response)
			: json(200, usage({})),
	);
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	const start = screen.getByTestId("workspace-start");
	start.focus();
	fireEvent.click(start);
	await waitFor(() => expect(start.getAttribute("aria-busy")).toBe("true"));
	expect(document.activeElement).toBe(start);
	finish(json(202, { ok: true }));
});

test("stopping asks for confirmation, then posts to the stop route", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	renderBar();
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-stop"));
	expect(screen.getByTestId("dialog-workspace-stop").textContent).toContain(
		"Your files are kept",
	);
	const stopCall = () =>
		fetchMock.mock.calls.find(([url]) => String(url).endsWith("/stop"));
	expect(stopCall()).toBeUndefined();

	fireEvent.click(screen.getByRole("button", { name: "Stop workspace" }));

	await waitFor(() => expect(stopCall()).toBeDefined());
	const [url, init] = stopCall() ?? [];
	expect(String(url)).toBe(`/workspaces/${WORKSPACE.id}/stop`);
	expect((init as RequestInit).method).toBe("POST");
	// The dialog stays open so the new state can appear in it.
	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
});

test("starting needs no confirmation", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-start"));

	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
		`/workspaces/${WORKSPACE.id}/start`,
	);
});

test("a long image fingerprint is shortened and kept in full in the title", () => {
	const fingerprint = "a".repeat(64);
	renderBar({ ...WORKSPACE, imageVersion: fingerprint });
	openStatus();

	const cell = screen.getByTestId("workspace-status-image");
	expect(cell.textContent).toBe(`${"a".repeat(12)}…`);
	expect(cell.getAttribute("title")).toBe(fingerprint);
});

const GB = 1024 ** 3;
function usage(
	storage: Record<string, { usedBytes: number; totalBytes: number } | null>,
) {
	return {
		observedAt: "2026-01-01T00:00:00.000Z",
		cpuPercent: 1,
		memory: { usedBytes: 1, totalBytes: 2 },
		disk: { usedBytes: 1, totalBytes: 2 },
		network: { receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 },
		processes: [],
		storage: { home: null, docker: null, recovery: null, ...storage },
	};
}
const percent = (value: number) => ({ usedBytes: value * GB, totalBytes: 100 * GB });

function stubUsage(storage: Parameters<typeof usage>[0]) {
	return stubFetch((url) =>
		String(url).endsWith("/usage")
			? json(200, usage(storage))
			: json(202, { ok: true }),
	);
}

test("below 80% the status bar shows no storage warning", async () => {
	const fetchMock = stubUsage({ docker: percent(79) });
	renderBar();

	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	openStatus();
	await waitFor(() =>
		expect(screen.getByTestId("storage-docker").textContent).toContain("79"),
	);
	expect(screen.queryByTestId("storage-warning")).toBeNull();
});

test("at 80% the status bar names the class", async () => {
	stubUsage({ recovery: percent(80) });
	renderBar();

	const warning = await screen.findByTestId("storage-warning");
	expect(warning.textContent).toBe("Recovery storage is 80% full");
	expect(warning.dataset.level).toBe("warning");
	// The live region holds fixed text; the percentage sits outside it.
	expect(warning.closest('[role="status"]')).toBeNull();
	expect(screen.getByTestId("storage-warning-announce").textContent).toBe(
		"Recovery storage is over 80% full",
	);
	expect(screen.getByTestId("storage-warning-announce").getAttribute("role")).toBe(
		"status",
	);
});

test("at 95% the dialog names the class and a next step", async () => {
	stubUsage({ docker: percent(96) });
	renderBar();

	const warning = await screen.findByTestId("storage-warning");
	expect(warning.textContent).toBe("Docker storage is nearly full");
	fireEvent.click(warning);
	expect(screen.getByTestId("storage-warning-detail").textContent).toContain(
		"Reset Docker",
	);
});

test("the dialog lists the three storage classes, and a missing one says so", async () => {
	stubUsage({ home: percent(10), docker: null, recovery: percent(1) });
	renderBar();
	openStatus();

	await waitFor(() =>
		expect(screen.getByTestId("storage-home").textContent).toContain("of"),
	);
	const meters = within(screen.getByTestId("storage-meters"));
	expect(meters.getByText("Projects and home")).toBeDefined();
	expect(meters.getByText("Docker")).toBeDefined();
	expect(meters.getByText("Recovery")).toBeDefined();
	expect(screen.getByTestId("storage-docker").textContent).toBe("Not available");
	expect(screen.getByTestId("storage-home").textContent).not.toContain("nearly full");
});

test("the dialog's sections each have a heading, and the details use the system chevron", () => {
	stubUsage({ home: percent(10), docker: percent(10), recovery: percent(1) });
	renderBar();
	openStatus();

	const dialog = within(screen.getByTestId("dialog-workspace-status"));
	const headings = dialog
		.getAllByRole("heading", { level: 3 })
		.map((h) => h.textContent);
	expect(headings).toEqual(["Keep running", "Storage", "Docker", "Rebuilds"]);
	const rebuilds = dialog.getByRole("region", { name: "Rebuilds" });
	expect(within(rebuilds).getByTestId("rebuild-note")).toBeDefined();
	const summary = screen
		.getByTestId("workspace-status-details")
		.querySelector("summary") as HTMLElement;
	expect(summary.textContent).toBe("Technical details");
	expect(summary.querySelector("svg")).not.toBeNull();
});

test("in error the dialog shows the figures the agent still reports, with no status-bar warning", async () => {
	stubUsage({ home: percent(10), docker: percent(99), recovery: percent(1) });
	renderBar({ ...WORKSPACE, state: "error", errorCode: "STORAGE_FULL" });
	openStatus();

	await waitFor(() =>
		expect(screen.getByTestId("storage-docker").textContent).toContain("nearly full"),
	);
	expect(screen.queryByTestId("storage-unavailable")).toBeNull();
	expect(screen.queryByTestId("storage-warning")).toBeNull();
});

test("the dialog's Restart, Reset Docker and Recovery storage each have a toggletip", async () => {
	stubUsage({ home: percent(10), docker: percent(10), recovery: percent(1) });
	renderBar();
	openStatus();

	const dialog = within(screen.getByTestId("dialog-workspace-status"));
	await waitFor(() => expect(dialog.getByTestId("storage-meters")).toBeDefined());
	for (const [label, phrase] of [
		["Restart workspace", "previews come back inactive"],
		["Reset Docker", "home folder and recovery points are kept"],
		["Recovery storage", "copies of your projects"],
	]) {
		fireEvent.click(dialog.getByRole("button", { name: `About ${label}` }));
		expect(openToggletip().textContent).toContain(phrase);
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
	}
});

test("a class over 80% says nearly full in words, not only colour (Gate E)", async () => {
	stubUsage({ home: percent(85), docker: percent(10), recovery: percent(1) });
	renderBar();
	openStatus();

	await waitFor(() =>
		expect(screen.getByTestId("storage-home").textContent).toContain(", nearly full"),
	);
	expect(screen.getByTestId("storage-docker").textContent).not.toContain("nearly full");
});

test("a stopped workspace asks for no usage and says when storage is shown", () => {
	const fetchMock = stubUsage({});
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("storage-unavailable").textContent).toBe(
		"Available when the workspace is running.",
	);
	expect(fetchMock).not.toHaveBeenCalled();
});

test("the dialog says sudo apt packages do not survive a rebuild", () => {
	renderBar();
	openStatus();

	expect(screen.getByTestId("rebuild-note").textContent).toContain(
		"programs installed with sudo apt are not",
	);
});

test("Reset Docker lists what is lost and kept, then posts", async () => {
	const fetchMock = stubUsage({});
	renderBar();
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-reset-docker"));
	const dialog = screen.getByTestId("dialog-reset-docker");
	for (const text of [
		"Docker images",
		"volumes",
		"build cache",
		"your projects",
		"recovery points",
	]) {
		expect(dialog.textContent).toContain(text);
	}
	fireEvent.click(screen.getByRole("button", { name: "Reset Docker" }));

	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some(([url]) =>
				String(url).endsWith(`/workspaces/${WORKSPACE.id}/reset-docker`),
			),
		).toBe(true),
	);
});

test("a pending operation shows its label and disables Reset Docker", () => {
	renderBar({ ...WORKSPACE, pendingOperation: "reset-docker" });

	expect(screen.getByTestId("workspace-state").textContent).toBe("Resetting Docker…");
	openStatus();
	const reset = screen.getByTestId("workspace-reset-docker");
	expect(reset.getAttribute("aria-disabled")).toBe("true");
	expect(reset.hasAttribute("disabled")).toBe(false);
	fireEvent.click(reset);
	expect(screen.queryByTestId("dialog-reset-docker")).toBeNull();
	expect(screen.getByTestId("workspace-transition").textContent).toBe(
		"Resetting Docker…",
	);
});

test("a pending rebuild reads Rebuilding", () => {
	renderBar({
		...WORKSPACE,
		state: "stopped",
		pendingOperation: "rebuild-reset-docker",
	});

	expect(screen.getByTestId("workspace-state").textContent).toBe("Rebuilding…");
	// The dialog's badge spins too, rather than showing the stopped ring.
	openStatus();
	const badge = screen.getByTestId("workspace-status-state");
	expect(badge.textContent).toBe("Rebuilding…");
	expect(badge.querySelector(".pk-spin")).not.toBeNull();
	expect(badge.querySelector(".pk-badge-ring")).toBeNull();
});

test("a refused Reset Docker is shown as an alert in the workspace dialog", async () => {
	stubFetch((url) =>
		url.endsWith("/reset-docker")
			? json(409, {
					code: "OPERATION_PENDING",
					message: "Another operation is pending.",
				})
			: json(200, usage({})),
	);
	renderBar();
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-reset-docker"));
	fireEvent.click(screen.getByRole("button", { name: "Reset Docker" }));

	const alert = await screen.findByTestId("dialog-error");
	expect(alert.getAttribute("role")).toBe("alert");
	expect(alert.textContent).toContain("Another operation is pending.");
});

test("the state button is plain muted text, not a tone, and has a trailing chevron", () => {
	renderBar();

	const button = screen.getByTestId("workspace-status");
	expect(button.classList.contains("pk-statusbar-plain")).toBe(true);
	expect(button.querySelector("svg[aria-hidden='true']")).not.toBeNull();
});

test("opened in restart mode, the dialog shows Restart's confirmation; Cancel leaves the dialog open", () => {
	renderBar(WORKSPACE, "restart");

	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
	expect(screen.getByTestId("dialog-workspace-restart")).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByTestId("dialog-workspace-restart")).toBeNull();
	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
});

test("a restart confirmation opened while the state settles waits with a reason, then restarts", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	const client = createQueryClient();
	const ui = (workspace: Workspace) => (
		<QueryClientProvider client={client}>
			<ToastProvider>
				<Bar workspace={workspace} initial="restart" />
			</ToastProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(ui({ ...WORKSPACE, state: "starting" }));
	const restartCall = () =>
		fetchMock.mock.calls.find(([url]) => String(url).endsWith("/restart"));

	const confirm = screen.getByTestId("dialog-confirm") as HTMLButtonElement;
	expect(confirm.disabled).toBe(false);
	expect(confirm.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("dialog-workspace-restart").textContent).toContain(
		"You can restart once it has finished.",
	);
	fireEvent.click(confirm);
	expect(screen.getByTestId("dialog-workspace-restart")).toBeDefined();
	expect(restartCall()).toBeUndefined();

	rerender(ui(WORKSPACE));
	fireEvent.click(screen.getByTestId("dialog-confirm"));
	await waitFor(() => expect(restartCall()).toBeDefined());
});

test("the dialog puts the state and its actions first and folds the technical details away", () => {
	renderBar();
	openStatus();

	const dialog = screen.getByTestId("dialog-workspace-status");
	const text = dialog.textContent ?? "";
	expect(text.indexOf("Restart workspace")).toBeLessThan(text.indexOf("Storage"));
	expect(text.indexOf("Storage")).toBeLessThan(text.indexOf("Reset Docker"));
	expect(screen.getByTestId("workspace-status-state").textContent).toContain("Running");
	const details = screen.getByTestId("workspace-status-details") as HTMLDetailsElement;
	expect(details.open).toBe(false);
	expect(details.querySelector("summary")?.textContent).toBe("Technical details");
	expect(within(details).getByText("Desired state")).toBeDefined();
	expect(within(details).getByText("Connections")).toBeDefined();
	expect(within(details).getByText("Image")).toBeDefined();
});

test("a meter warns at 85% of the limit and not at 84.9%", () => {
	expect(usageMeter({ usedBytes: 849, totalBytes: 1000 })?.level).toBe("ok");
	expect(usageMeter({ usedBytes: 85 * GB, totalBytes: 100 * GB })).toEqual({
		usedBytes: 85 * GB,
		totalBytes: 100 * GB,
		high: 85 * GB - 1,
		valueText: "85.0 GB of 100 GB",
		shortText: "85%",
		level: "warning",
	});
	expect(usageMeter({ usedBytes: 1, totalBytes: 0 })).toBeNull();
	expect(usageMeter(undefined)).toBeNull();
	expect(usageMeter(null)).toBeNull();
});

test("a warning meter stays so until use falls below 80%", () => {
	const at = (value: number) => ({ usedBytes: value * GB, totalBytes: 100 * GB });
	expect(usageMeter(at(82))?.level).toBe("ok");
	expect(usageMeter(at(82), true)?.level).toBe("warning");
	expect(usageMeter(at(80), true)?.level).toBe("warning");
	expect(usageMeter(at(79.9), true)?.level).toBe("ok");
});

test("the Meter's warning mark follows the threshold in force, so its words match the level", () => {
	const at = (value: number) => ({ usedBytes: value * GB, totalBytes: 100 * GB });
	for (const [figure, warned] of [
		[at(84.9), false],
		[at(85), false],
		[at(82), true],
		[at(79.9), true],
		[at(97), false],
	] as const) {
		const meter = usageMeter(figure, warned, true);
		if (!meter) throw new Error("no meter");
		const warns = meter.usedBytes > meter.high;
		expect(warns).toBe(meter.level !== "ok");
	}
});

test("the visible percentage rounds down, so it never claims a line not yet crossed", () => {
	const at = (value: number) => ({ usedBytes: value * GB, totalBytes: 100 * GB });
	expect(usageMeter(at(94.9), false, true)?.shortText).toBe("94%");
	expect(usageMeter(at(84.99))?.shortText).toBe("84%");
	expect(usageMeter(at(120))?.shortText).toBe("120%");
});

test("only the disk meter turns full at 95%", () => {
	const at = (value: number) => ({ usedBytes: value * GB, totalBytes: 100 * GB });
	expect(usageMeter(at(95))?.level).toBe("warning");
	expect(usageMeter(at(95), false, true)?.level).toBe("full");
	expect(usageMeter(at(94.9), false, true)?.level).toBe("warning");
});

function rightPane() {
	return {
		pane: "files" as const,
		show: vi.fn(),
		monitorSort: { column: "cpu" as const, direction: "desc" as const },
		setMonitorSort: vi.fn(),
		monitorFocus: false,
		setMonitorFocus: vi.fn(),
	};
}

function stubMemory(usedPercent: number, storage: Parameters<typeof usage>[0] = {}) {
	return stubFetch((url) =>
		String(url).endsWith("/usage")
			? json(200, {
					...usage(storage),
					memory: { usedBytes: usedPercent * GB, totalBytes: 100 * GB },
				})
			: json(202, { ok: true }),
	);
}

test("below 85% both meters show in the plain tone and nothing is announced", async () => {
	stubMemory(40, { home: percent(30) });
	renderBar();

	const memory = await screen.findByTestId("memory-meter");
	expect(memory.tagName).toBe("BUTTON");
	expect(memory.textContent).toBe("Memory40%");
	expect(memory.dataset.level).toBe("ok");
	expect(memory.getAttribute("aria-label")).toBe(
		"Memory 40%, 40.0 GB of 100 GB. See what's using memory",
	);
	expect(memory.querySelector("svg")).toBeNull();
	const disk = await screen.findByTestId("disk-meter");
	expect(disk.dataset.level).toBe("ok");
	expect(disk.getAttribute("aria-label")).toBe(
		"Disk 30%, 30.0 GB of 100 GB. Open workspace storage",
	);
	// The bar is the ui Meter, a native meter with the figures (SPEC.md §25.8).
	const bar = disk.querySelector("meter");
	expect(bar?.value).toBe(30 * GB);
	expect(bar?.max).toBe(100 * GB);
	expect(screen.getByTestId("memory-warning-announce").textContent).toBe("");
	expect(screen.getByTestId("storage-warning-announce").textContent).toBe("");
	expect(screen.queryByTestId("storage-warning")).toBeNull();
});

test("at 85% memory the meter warns, announces it, and opens Monitor by memory", async () => {
	stubMemory(90);
	const api = rightPane();
	renderWithQuery(
		<RightPaneContext.Provider value={api}>
			<Bar workspace={WORKSPACE} />
		</RightPaneContext.Provider>,
	);

	const meter = await screen.findByTestId("memory-meter");
	await waitFor(() => expect(meter.dataset.level).toBe("warning"));
	expect(meter.className).toContain("pk-meter--warning");
	// The alert icon, and "nearly full" in the name, mark it as a warning, not colour
	// alone; the name starts with the visible words.
	expect(meter.querySelector("svg")).not.toBeNull();
	expect(meter.textContent).toBe("Memory90%");
	expect(meter.getAttribute("aria-label")).toBe(
		"Memory 90%, 90.0 GB of 100 GB, nearly full. See what's using memory",
	);
	// Memory has its own live region, so a storage change does not repeat it.
	expect(screen.getByTestId("memory-warning-announce").textContent).toBe(
		MEMORY_ANNOUNCEMENT,
	);
	expect(screen.getByTestId("storage-warning-announce").textContent).toBe("");
	fireEvent.click(meter);
	expect(api.setMonitorSort).toHaveBeenCalledWith({
		column: "memory",
		direction: "desc",
	});
	expect(api.show).toHaveBeenCalledWith("monitor");
	expect(api.setMonitorFocus).toHaveBeenCalledWith(true);
});

test("the disk meter shows the home volume, warns at 85%, and opens the workspace dialog", async () => {
	stubMemory(10, { home: percent(88), docker: percent(10) });
	renderBar();

	const disk = await screen.findByTestId("disk-meter");
	await waitFor(() => expect(disk.dataset.level).toBe("warning"));
	expect(disk.getAttribute("aria-haspopup")).toBe("dialog");
	expect(disk.getAttribute("aria-label")).toBe(
		"Disk 88%, 88.0 GB of 100 GB, nearly full. Open workspace storage",
	);
	// The storage warning keeps its own wording beside it.
	expect(screen.getByTestId("storage-warning").textContent).toBe(
		"Projects and home storage is 88% full",
	);
	fireEvent.click(disk);
	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
});

test("a full home volume draws the disk meter in the error tone", async () => {
	stubMemory(10, { home: percent(97) });
	renderBar();

	const disk = await screen.findByTestId("disk-meter");
	await waitFor(() => expect(disk.dataset.level).toBe("full"));
	expect(disk.className).toContain("pk-meter--full");
	expect(disk.getAttribute("aria-label")).toBe(
		"Disk 97%, 97.0 GB of 100 GB, nearly full. Open workspace storage",
	);
});

test("with no home figure there is no disk meter", async () => {
	const fetchMock = stubMemory(10);
	renderBar();
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	await screen.findByTestId("memory-meter");
	expect(screen.queryByTestId("disk-meter")).toBeNull();
});

test("a stopped workspace shows no meters", () => {
	stubMemory(90, { home: percent(90) });
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	expect(screen.queryByTestId("memory-meter")).toBeNull();
	expect(screen.queryByTestId("disk-meter")).toBeNull();
});
