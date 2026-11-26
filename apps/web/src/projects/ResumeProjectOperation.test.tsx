import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	json,
	operation,
	project,
	renderWithQuery,
	stubFetch,
	WORKSPACE,
} from "../test-utils.js";
import {
	isOperationHandled,
	markOperationHandled,
	markOperationStarted,
	useHandOffOnClose,
} from "./operations.js";
import { ResumeProjectOperation } from "./ResumeProjectOperation.js";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate,
}));

const READ = `/workspaces/${WORKSPACE.id}/project-operation`;
const RUNNING = operation({ kind: "duplicate" });

beforeEach(() => {
	sessionStorage.clear();
	navigate.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function serve(...reads: unknown[]) {
	return stubFetch((url) => {
		if (url === READ)
			return json(200, { operation: reads.shift() ?? reads.at(-1) ?? null });
		return json(200, { projects: [] });
	});
}

function show(running = true) {
	renderWithQuery(
		<ResumeProjectOperation workspaceId={WORKSPACE.id} running={running} />,
	);
}

test("a running operation found after a reload shows progress, then offers the project without opening it", async () => {
	const made = project({ name: "lab copy" });
	serve(RUNNING, { ...RUNNING, state: "succeeded", project: made });
	show();
	expect(await screen.findByText("Still duplicating your project…")).toBeDefined();
	// A duplicate is announced as one, not as "created".
	expect(
		await screen.findByText("lab copy duplicated", {}, { timeout: 3000 }),
	).toBeDefined();
	expect(screen.queryByText("Still duplicating your project…")).toBeNull();
	// The page stays where the student is until they ask to open it.
	expect(navigate).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Open project" }));
	expect(navigate).toHaveBeenCalledWith({
		to: "/workspaces/$id/projects/$projectId",
		params: { id: WORKSPACE.id, projectId: made.id },
	});
	expect(isOperationHandled(RUNNING.id)).toBe(true);
});

test("a finished create this tab started is announced as created", async () => {
	markOperationStarted(RUNNING.id);
	serve({
		...RUNNING,
		kind: "create",
		state: "succeeded",
		project: project({ name: "lab" }),
	});
	show();
	expect(await screen.findByText("lab created")).toBeDefined();
});

test("a failure this tab started shows the server's message", async () => {
	markOperationStarted(RUNNING.id);
	serve({
		...RUNNING,
		kind: "create",
		state: "failed",
		error: { status: 400, code: "GIT_FAILED", message: "The clone failed." },
	});
	show();
	expect(await screen.findByText("The project was not created")).toBeDefined();
	expect(screen.getByText("The clone failed.")).toBeDefined();
	expect(navigate).not.toHaveBeenCalled();
});

test("a finished restore this tab started shows that it finished", async () => {
	markOperationStarted(RUNNING.id);
	serve({ ...RUNNING, kind: "restore", state: "succeeded" });
	show();
	expect(await screen.findByText("Project restored")).toBeDefined();
});

test("a finished operation another tab started is not replayed", async () => {
	const fetchMock = serve({ ...RUNNING, state: "succeeded", project: project() });
	show();
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
	expect(screen.queryByText(/duplicated/)).toBeNull();
	expect(navigate).not.toHaveBeenCalled();
});

test("an outcome this tab already showed is not shown again", async () => {
	markOperationStarted(RUNNING.id);
	const fetchMock = serve({ ...RUNNING, state: "succeeded", project: project() });
	markOperationHandled(RUNNING.id);
	show();
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
	expect(screen.queryByText(/duplicated/)).toBeNull();
	expect(navigate).not.toHaveBeenCalled();
});

type Run = ReturnType<ReturnType<typeof useHandOffOnClose>>;

/** Stands in for a dialog whose mutation starts an operation. */
function Dialog({ started }: { started: (run: Run) => void }) {
	const follow = useHandOffOnClose(WORKSPACE.id);
	return (
		<button type="button" onClick={() => started(follow())}>
			start
		</button>
	);
}

/** The page's follower, which the test can take away. */
function LeavingPage() {
	const [shown, setShown] = useState(true);
	return (
		<>
			{shown && <ResumeProjectOperation workspaceId={WORKSPACE.id} running />}
			<button type="button" onClick={() => setShown(false)}>
				leave
			</button>
		</>
	);
}

/** The page's follower beside a dialog the test can close. */
function PageWithDialog({ started }: { started: (run: Run) => void }) {
	const [open, setOpen] = useState(true);
	return (
		<>
			<ResumeProjectOperation workspaceId={WORKSPACE.id} running />
			{open && <Dialog started={started} />}
			<button type="button" onClick={() => setOpen(false)}>
				close
			</button>
		</>
	);
}

test("leaving the page stops the checks", async () => {
	const fetchMock = serve(RUNNING);
	renderWithQuery(<LeavingPage />);
	expect(await screen.findByText("Still duplicating your project…")).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "leave" }));
	const reads = fetchMock.mock.calls.length;
	await new Promise((resolve) => setTimeout(resolve, 1300));
	expect(fetchMock.mock.calls.length).toBe(reads);
});

test("an operation a closed dialog left running is announced by the page", async () => {
	const made = project({ name: "lab copy" });
	// Nothing runs at load; the dialog starts one afterwards.
	serve(null, { ...RUNNING, state: "succeeded", project: made });
	let signal: AbortSignal | undefined;
	renderWithQuery(
		<PageWithDialog
			started={(run) => {
				signal = run.signal;
				run.onStarted?.(RUNNING);
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "start" }));
	fireEvent.click(screen.getByRole("button", { name: "close" }));
	expect(signal?.aborted).toBe(true);
	expect(
		await screen.findByText("lab copy duplicated", {}, { timeout: 3000 }),
	).toBeDefined();
	expect(screen.getByRole("button", { name: "Open project" })).toBeDefined();
	expect(navigate).not.toHaveBeenCalled();
});

test("a stopped workspace is not asked", () => {
	const fetchMock = serve(null);
	show(false);
	expect(fetchMock).not.toHaveBeenCalled();
});
