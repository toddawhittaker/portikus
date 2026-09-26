import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "./test-utils.js";
import {
	offerDockerCleanup,
	startingPhase,
	WorkspaceStarting,
} from "./WorkspaceStarting.js";

const noop = () => {};

test("no workspace yet means connecting", () => {
	expect(startingPhase(null)).toBe("connecting");
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={null}
			onOpenWorkspace={noop}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Connecting to your workspace");
});

test("a stopped workspace that should run is starting", () => {
	const workspace = { ...WORKSPACE, state: "stopped" as const };
	expect(startingPhase(workspace)).toBe("starting");
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={workspace}
			onOpenWorkspace={noop}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Starting your workspace");
});

test("a running workspace is reopening tabs", () => {
	expect(startingPhase(WORKSPACE)).toBe("restoring");
});

test("stopping and error have their own copy, and the error shows the detail", () => {
	expect(startingPhase({ ...WORKSPACE, state: "stopping" })).toBe("stopping");
	const failed = {
		...WORKSPACE,
		state: "error" as const,
		errorCode: "STORAGE_FULL",
		errorMessage: "Your workspace could not start because its storage is full.",
	};
	expect(startingPhase(failed)).toBe("error");

	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={failed}
			onOpenWorkspace={noop}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe(
		"Your workspace could not be started",
	);
	expect(
		screen.getByText("Your workspace could not start because its storage is full."),
	).toBeDefined();
	expect(screen.getByText("STORAGE_FULL")).toBeDefined();
	// The raw detail is folded away under "Technical details".
	const details = screen.getByTestId("workspace-error-details") as HTMLDetailsElement;
	expect(details.open).toBe(false);
	expect(details.querySelector("summary")?.textContent).toBe("Technical details");
	// Nothing is loading, so no skeleton.
	expect(document.querySelector(".pk-tabs-skeleton")).toBeNull();
});

afterEach(() => vi.unstubAllGlobals());

test("the error screen's Try again starts the workspace and Workspace details opens the dialog", async () => {
	const calls: string[] = [];
	stubFetch((url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url} ${String(init?.body ?? "")}`);
		return json(202, { ...WORKSPACE, state: "starting" });
	});
	const onOpenWorkspace = vi.fn();
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "error" }}
			onOpenWorkspace={onOpenWorkspace}
		/>,
	);

	fireEvent.click(screen.getByRole("button", { name: "Workspace details" }));
	expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	await waitFor(() => expect(calls.some((call) => call.includes("start"))).toBe(true));
});

test("the skeleton shows while starting, not while stopped", () => {
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "starting" }}
			onOpenWorkspace={noop}
		/>,
	);
	expect(document.querySelector(".pk-tabs-skeleton")).not.toBeNull();
});

test("a workspace the student stopped offers a way to start it again", () => {
	const workspace = {
		...WORKSPACE,
		state: "stopped" as const,
		desiredState: "stopped" as const,
	};
	expect(startingPhase(workspace)).toBe("stopped");

	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={workspace}
			onOpenWorkspace={noop}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Your workspace is stopped");
	expect(screen.getByTestId("workspace-resume")).toBeDefined();
	// Nothing is happening, so there is no spinner pretending otherwise.
	expect(document.querySelector(".pk-spin")).toBeNull();
});

test("a pending Reset Docker or Rebuild says so instead of the phase", () => {
	renderWithQuery(
		<WorkspaceStarting
			onOpenWorkspace={noop}
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopping", pendingOperation: "reset-docker" }}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Resetting Docker…");
	expect(screen.getByTestId("workspace-progress").dataset.pending).toBe("reset-docker");
});

test("a pending rebuild reads Rebuilding and says projects are kept", () => {
	renderWithQuery(
		<WorkspaceStarting
			onOpenWorkspace={noop}
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopped", pendingOperation: "rebuild" }}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Rebuilding…");
	expect(screen.getByTestId("workspace-progress").textContent).toContain(
		"Your projects and home folder are kept",
	);
});

test("a stop after an unanswered Still working? says why", () => {
	renderWithQuery(
		<WorkspaceStarting
			onOpenWorkspace={noop}
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopped", desiredState: "stopped" }}
			idleStop={{ minutes: 60 }}
		/>,
	);
	expect(screen.getByTestId("idle-stopped").textContent).toBe(
		"Stopped after 60 minutes without activity.",
	);
});

test("without an idle stop the stopped screen says nothing about it", () => {
	renderWithQuery(
		<WorkspaceStarting
			onOpenWorkspace={noop}
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopped", desiredState: "stopped" }}
		/>,
	);
	expect(screen.queryByTestId("idle-stopped")).toBeNull();
});

const GB = 1024 ** 3;
const at = (percent: number) => ({ usedBytes: percent * GB, totalBytes: 100 * GB });

test("Clean up Docker is offered only for STORAGE_FULL with Docker at the critical level", () => {
	expect(
		offerDockerCleanup("STORAGE_FULL", {
			home: at(10),
			docker: at(96),
			recovery: null,
		}),
	).toBe(true);
	// Projects storage is what filled up: a Docker reset would destroy data for nothing.
	expect(
		offerDockerCleanup("STORAGE_FULL", {
			home: at(99),
			docker: at(85),
			recovery: null,
		}),
	).toBe(false);
	expect(
		offerDockerCleanup("AGENT_UNAVAILABLE", {
			home: null,
			docker: at(99),
			recovery: null,
		}),
	).toBe(false);
	expect(offerDockerCleanup("STORAGE_FULL", undefined)).toBe(false);
});

function stubUsage(docker: { usedBytes: number; totalBytes: number } | null) {
	stubFetch((url) =>
		String(url).endsWith("/usage")
			? json(200, {
					observedAt: "2026-01-01T00:00:00.000Z",
					cpuPercent: 1,
					memory: { usedBytes: 1, totalBytes: 2 },
					disk: { usedBytes: 1, totalBytes: 2 },
					network: { receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 },
					processes: [],
					storage: { home: at(10), docker, recovery: null },
				})
			: json(202, { ok: true }),
	);
}

test("the error screen shows the meters and Clean up Docker when Docker filled up", async () => {
	stubUsage(at(99));
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "error", errorCode: "STORAGE_FULL" }}
			onOpenWorkspace={noop}
		/>,
	);

	await screen.findByTestId("storage-meters");
	const clean = await screen.findByRole("button", { name: "Clean up Docker…" });
	fireEvent.click(clean);
	expect(screen.getByTestId("dialog-reset-docker")).toBeDefined();
});

test("with Docker not full the error screen shows the meters but no Clean up Docker", async () => {
	stubUsage(at(20));
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "error", errorCode: "STORAGE_FULL" }}
			onOpenWorkspace={noop}
		/>,
	);

	await screen.findByTestId("storage-meters");
	expect(screen.queryByRole("button", { name: "Clean up Docker…" })).toBeNull();
});

test("with no figures the error screen offers only Try again and Workspace details", async () => {
	stubFetch(() => json(503, { code: "AGENT_UNAVAILABLE", message: "no" }));
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "error", errorCode: "STORAGE_FULL" }}
			onOpenWorkspace={noop}
		/>,
	);

	expect(screen.queryByTestId("storage-meters")).toBeNull();
	const names = screen.getAllByRole("button").map((button) => button.textContent);
	expect(names).toEqual(["Try again", "Workspace details"]);
});
