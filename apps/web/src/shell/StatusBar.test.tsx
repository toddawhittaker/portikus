import type { Workspace } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { StatusBar } from "./StatusBar.js";
import type { WorkspaceDialogMode } from "./WorkspaceDialog.js";

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
	expect(meters.getByText("Projects & home")).toBeDefined();
	expect(meters.getByText("Docker")).toBeDefined();
	expect(meters.getByText("Recovery")).toBeDefined();
	expect(screen.getByTestId("storage-docker").textContent).toBe("Not available");
	expect(screen.getByTestId("storage-home").textContent).not.toContain("nearly full");
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
