import type { AssistantStatus } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	FakeWebSocket,
	json,
	renderWithQuery,
	stubFetch,
	USER,
} from "../test-utils.js";
import { AssistantProvider } from "./AssistantContext.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { DiagnoseButton } from "./DiagnoseButton.js";

/** A Diagnose button shows for an administrator while the assistant is enabled, and opens a read-only conversation (SPEC.md section 20.5). */

const ADMIN = { ...USER, role: "administrator" as const };
const INSTRUCTOR = { ...USER, role: "instructor" as const };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

function stubServer(
	status: AssistantStatus,
	user: typeof ADMIN | typeof INSTRUCTOR,
	created: unknown[] = [],
) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, user);
		if (url === "/assistant/status") return json(200, status);
		if (url === "/assistant/conversations" && init?.method === "POST") {
			created.push(JSON.parse(String(init.body)));
			return json(201, {
				id: CONVERSATION,
				title: "",
				courseId: null,
				context: { kind: "workspace", id: WORKSPACE },
				readOnly: true,
				tokensUsed: 0,
				createdAt: "2026-11-01T00:00:00.000Z",
				lastActiveAt: "2026-11-15T10:00:00.000Z",
			});
		}
		if (url === "/assistant/conversations") return json(200, { conversations: [] });
		return json(404, { error: "not stubbed" });
	});
}

beforeEach(() => {
	FakeWebSocket.all = [];
	FakeWebSocket.last = null;
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function page(onOpen?: () => void) {
	return (
		<AssistantProvider>
			<DiagnoseButton
				context={{ kind: "workspace", id: WORKSPACE }}
				name="Diagnose Ada's workspace"
				onOpen={onOpen}
			/>
			<AssistantPanel />
		</AssistantProvider>
	);
}

test("an administrator sees it while the assistant is on, and it starts a read-only conversation about the item", async () => {
	const created: unknown[] = [];
	stubServer({ enabled: true, reason: null }, ADMIN, created);
	const opened = vi.fn();
	renderWithQuery(page(opened));
	fireEvent.click(
		await screen.findByRole("button", { name: "Diagnose Ada's workspace" }),
	);
	await waitFor(() =>
		expect(created).toEqual([{ context: { kind: "workspace", id: WORKSPACE } }]),
	);
	expect(opened).toHaveBeenCalledTimes(1);
	expect(await screen.findByTestId("assistant-panel")).toBeTruthy();
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
});

test("it is absent while the assistant is off, for an instructor, and on a page without the assistant", async () => {
	stubServer({ enabled: false, reason: "off" }, ADMIN);
	renderWithQuery(page());
	await screen.findByText("", { selector: "body" });
	await waitFor(() => expect(screen.queryByTestId("diagnose-workspace")).toBeNull());
	cleanup();

	stubServer({ enabled: true, reason: null }, INSTRUCTOR);
	renderWithQuery(page());
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(screen.queryByTestId("diagnose-workspace")).toBeNull();
	cleanup();

	stubServer({ enabled: true, reason: null }, ADMIN);
	renderWithQuery(
		<DiagnoseButton context={{ kind: "health" }} name="Diagnose site health" />,
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(screen.queryByTestId("diagnose-health")).toBeNull();
});
