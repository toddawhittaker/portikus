import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	json,
	operation,
	project,
	renderWithQuery,
	stubFetch,
	WORKSPACE,
} from "../test-utils.js";
import { isOperationHandled, markOperationHandled } from "./operations.js";
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

test("a running operation found after a reload shows progress, then opens the project", async () => {
	const made = project({ name: "lab copy" });
	serve(RUNNING, { ...RUNNING, state: "succeeded", project: made });
	show();
	expect(await screen.findByText("Still duplicating your project…")).toBeDefined();
	expect(
		await screen.findByText("lab copy created", {}, { timeout: 3000 }),
	).toBeDefined();
	expect(navigate).toHaveBeenCalledWith({
		to: "/workspaces/$id/projects/$projectId",
		params: { id: WORKSPACE.id, projectId: made.id },
	});
	expect(screen.queryByText("Still duplicating your project…")).toBeNull();
	expect(isOperationHandled(RUNNING.id)).toBe(true);
});

test("a failure found after a reload shows the server's message", async () => {
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

test("a finished restore shows that it finished", async () => {
	serve({ ...RUNNING, kind: "restore", state: "succeeded" });
	show();
	expect(await screen.findByText("Restore finished")).toBeDefined();
});

test("an outcome this tab already showed is not shown again", async () => {
	const fetchMock = serve({ ...RUNNING, state: "succeeded", project: project() });
	markOperationHandled(RUNNING.id);
	show();
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(screen.queryByText(/created/)).toBeNull();
	expect(navigate).not.toHaveBeenCalled();
});

test("a stopped workspace is not asked", () => {
	const fetchMock = serve(null);
	show(false);
	expect(fetchMock).not.toHaveBeenCalled();
});
