import type { LogLine, LogPage } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../api/request.js";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import {
	levelTagClass,
	levelText,
	linesText,
	messageOf,
	partialText,
	refreshNote,
} from "./LogsTab.js";
import { refreshInterval, retryBusy } from "./queries.js";

afterEach(() => vi.unstubAllGlobals());

const ALICE = "11111111-2222-4333-8444-555555555555";
const WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function cursor(index: number): string {
	const hex = "0".repeat(32);
	return `s=${hex};i=${index.toString(16)};b=${hex};m=1;t=1;x=1`;
}

function logLine(
	index: number,
	line: Record<string, unknown>,
	userName: string | null = null,
): LogLine {
	return {
		cursor: cursor(index),
		at: "2026-09-26T10:00:00.000Z",
		service: "api",
		line: { level: "warn", service: "api", time: "2026-09-26T10:00:00.000Z", ...line },
		userName,
	};
}

function page(lines: LogLine[], nextCursor: string | null = null): LogPage {
	return { lines, nextCursor, scanComplete: true, skippedLines: 0 };
}

/** Serves `/admin/logs` from `answer` and records every query string. */
function stubLogs(answer: (params: URLSearchParams) => Response) {
	const requested: URLSearchParams[] = [];
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url.startsWith("/admin/logs?")) {
			const params = new URLSearchParams(url.split("?")[1]);
			requested.push(params);
			return answer(params);
		}
		return json(200, {});
	});
	return requested;
}

test("level tags name the level in words, coloured where it applies", () => {
	expect(levelText("fatal")).toBe("Fatal");
	expect(levelText("warn")).toBe("Warn");
	expect(levelText("trace")).toBe("trace");
	expect(levelTagClass("fatal")).toBe("pk-tag pk-tag--error");
	expect(levelTagClass("warn")).toBe("pk-tag pk-tag--warning");
	expect(levelTagClass("info")).toBe("pk-tag");
	expect(messageOf({ msg: "request", error: "Too many terminals" })).toBe(
		"Too many terminals",
	);
	expect(messageOf({ msg: "request" })).toBe("request");
	expect(linesText(1, false)).toBe("1 line");
	expect(linesText(100, true)).toBe("100 lines, older lines available");
});

test("a busy journal is tried twice more, an unavailable one is not", () => {
	const busy = new ApiError(429, "busy", "RATE_LIMITED");
	expect(retryBusy(0, busy)).toBe(true);
	expect(retryBusy(1, busy)).toBe(true);
	expect(retryBusy(2, busy)).toBe(false);
	expect(retryBusy(0, new ApiError(503, "no", "LOGS_UNAVAILABLE"))).toBe(false);
});

test("automatic refresh pauses once older lines are loaded", () => {
	expect(refreshInterval(0)).toBe(30_000);
	expect(refreshInterval(1)).toBe(30_000);
	expect(refreshInterval(2)).toBe(false);
	expect(refreshInterval(1, false)).toBe(false);
	expect(refreshNote(true, false)).toBe("Refreshes every 30 seconds.");
	expect(refreshNote(false, false)).toBe("Automatic refresh is off.");
	expect(refreshNote(true, true)).toContain("paused while older lines are shown");
});

test("Auto refresh is a visible toggle with a note saying what it does (WCAG 2.2.2)", async () => {
	stubLogs(() => json(200, page([logLine(1, { msg: "one" })])));
	renderApp("/admin?tab=logs");
	await screen.findByText("one");
	const toggle = screen.getByRole("button", { name: "Auto refresh" });
	expect(toggle.getAttribute("aria-pressed")).toBe("true");
	expect(screen.getByTestId("logs-refresh-note").textContent).toBe(
		"Refreshes every 30 seconds.",
	);
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-pressed")).toBe("false");
	expect(screen.getByTestId("logs-refresh-note").textContent).toBe(
		"Automatic refresh is off.",
	);
});

test("Auto refresh stays off when a new filter is applied", async () => {
	stubLogs(() => json(200, page([logLine(1, { msg: "one" })])));
	renderApp("/admin?tab=logs");
	await screen.findByText("one");
	fireEvent.click(screen.getByRole("button", { name: "Auto refresh" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Info" }));
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
	await waitFor(() =>
		expect(screen.getByTestId("logs-refresh-note").textContent).toBe(
			"Automatic refresh is off.",
		),
	);
	await screen.findByText("one");
	expect(
		screen.getByRole("button", { name: "Auto refresh" }).getAttribute("aria-pressed"),
	).toBe("false");
});

test("Refresh announces the count again even when it has not changed", async () => {
	stubLogs((params) =>
		params.get("cursor")
			? json(200, page([logLine(1, { msg: "older" })], cursor(1)))
			: json(
					200,
					page([logLine(5, { msg: "newest" }), logLine(4, { msg: "next" })], cursor(4)),
				),
	);
	renderApp("/admin?tab=logs");
	await screen.findByText("newest");
	fireEvent.click(screen.getByRole("button", { name: "Load older lines" }));
	await screen.findByText("older");
	const announce = screen.getByTestId("logs-announce");
	const seen: string[] = [];
	const observer = new MutationObserver(() => seen.push(announce.textContent ?? ""));
	observer.observe(announce, { childList: true, subtree: true, characterData: true });
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() => expect(seen.at(-1)).toMatch(/^2 lines/));
	observer.disconnect();
	expect(seen).toContain("");
});

test("older pages keep the first page's start time, so a preset window does not slide", async () => {
	const requested = stubLogs((params) =>
		params.get("cursor")
			? json(200, page([logLine(1, { msg: "older" })]))
			: json(200, page([logLine(5, { msg: "newest" })], cursor(5))),
	);
	renderApp("/admin?tab=logs");
	await screen.findByText("newest");
	await new Promise((resolve) => setTimeout(resolve, 20));
	fireEvent.click(screen.getByRole("button", { name: "Load older lines" }));
	await screen.findByText("older");
	expect(requested[1]?.get("since")).toBe(requested[0]?.get("since"));
});

test("Load older stays focusable while busy, then hands focus to the first new row", async () => {
	stubLogs((params) =>
		params.get("cursor")
			? json(200, page([logLine(1, { msg: "older" })]))
			: json(200, page([logLine(5, { msg: "newest" })], cursor(5))),
	);
	renderApp("/admin?tab=logs");
	await screen.findByText("newest");
	const older = screen.getByRole("button", { name: "Load older lines" });
	older.focus();
	fireEvent.click(older);
	expect(older.hasAttribute("disabled")).toBe(false);
	await screen.findByText("older");
	const toggles = screen.getAllByTestId("log-row-toggle");
	await waitFor(() => expect(document.activeElement).toBe(toggles[1]));
	expect(screen.getByTestId("logs-announce").textContent).toBe("2 lines");
});

test("Refresh puts focus on the Logs heading before it goes away", async () => {
	stubLogs((params) =>
		params.get("cursor")
			? json(200, page([logLine(1, { msg: "older" })], cursor(1)))
			: json(200, page([logLine(5, { msg: "newest" })], cursor(5))),
	);
	renderApp("/admin?tab=logs");
	await screen.findByText("newest");
	fireEvent.click(screen.getByRole("button", { name: "Load older lines" }));
	await screen.findByText("older");
	const refresh = screen.getByRole("button", { name: "Refresh" });
	refresh.focus();
	fireEvent.click(refresh);
	await waitFor(() => expect(screen.queryByTestId("logs-refresh")).toBeNull());
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { level: 2, name: "Logs" }),
	);
});

test("the row toggle is at least 24 pixels square", async () => {
	stubLogs(() => json(200, page([logLine(1, { msg: "one" })])));
	renderApp("/admin?tab=logs");
	const toggle = await screen.findByTestId("log-row-toggle");
	expect(toggle.className).toContain("min-h-6");
	expect(toggle.className).toContain("min-w-6");
});

test("rows show named fields as text, and a row expands to the whole line", async () => {
	stubLogs(() =>
		json(
			200,
			page([
				logLine(
					1,
					{
						code: "TERMINAL_LIMIT",
						msg: "request",
						error: "<b>A workspace</b> may have at most 20 terminals open.",
						route: "/workspaces/:id/terminals",
						status: 409,
						userId: ALICE,
						workspaceId: WS,
					},
					"Alice Example",
				),
				logLine(2, { level: "error", msg: "boom", userId: WS }),
			]),
		),
	);

	renderApp("/admin?tab=logs");

	const rows = await screen.findAllByTestId("log-row");
	expect(rows).toHaveLength(2);
	const first = rows[0] as HTMLElement;
	expect(within(first).getByTestId("log-level").textContent).toBe("Warn");
	expect(within(first).getByText("TERMINAL_LIMIT")).toBeDefined();
	expect(within(first).getByText("Alice Example")).toBeDefined();
	expect(within(first).getByText("409")).toBeDefined();
	// The line is text, never markup.
	const message = within(first).getByTestId("log-message");
	expect(message.textContent).toBe(
		"<b>A workspace</b> may have at most 20 terminals open.",
	);
	expect(message.querySelector("b")).toBeNull();
	// An unknown user shows the short id; the full id is there for screen readers.
	expect(within(rows[1] as HTMLElement).getByText("aaaaaaaa")).toBeDefined();
	expect(screen.getByTestId("logs-count").textContent).toBe("2 lines");

	const toggle = within(first).getByTestId("log-row-toggle");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	const detail = screen.getByTestId("log-row-detail");
	expect(toggle.getAttribute("aria-controls")).toBe(detail.id);
	expect(detail.textContent).toContain('"code": "TERMINAL_LIMIT"');
	expect(detail.querySelector("b")).toBeNull();
});

test("loading older lines pauses refresh and offers Refresh, which starts over", async () => {
	const requested = stubLogs((params) =>
		params.get("cursor")
			? json(200, page([logLine(1, { msg: "older" })]))
			: json(200, page([logLine(5, { msg: "newest" })], cursor(5))),
	);

	renderApp("/admin?tab=logs");

	expect(await screen.findByText("newest")).toBeDefined();
	expect(screen.queryByTestId("logs-refresh")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Load older lines" }));

	expect(await screen.findByText("older")).toBeDefined();
	expect(requested.at(-1)?.get("cursor")).toBe(cursor(5));
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

	await waitFor(() => expect(screen.queryByText("older")).toBeNull());
	expect(await screen.findByText("newest")).toBeDefined();
	expect(screen.queryByTestId("logs-refresh")).toBeNull();
	expect(requested.at(-1)?.has("cursor")).toBe(false);
});

test("a busy journal and an unavailable one say so", async () => {
	const busy = stubLogs(() =>
		json(429, {
			code: "RATE_LIMITED",
			message: "Log search is busy. Try again in a moment.",
		}),
	);
	const first = renderApp("/admin?tab=logs");
	// Two quiet retries a second apart, then the message.
	expect((await screen.findByRole("alert", {}, { timeout: 5_000 })).textContent).toBe(
		"Log search is busy. Try again in a moment.",
	);
	expect(busy).toHaveLength(3);
	first.unmount();

	stubLogs(() =>
		json(503, {
			code: "LOGS_UNAVAILABLE",
			message:
				"The platform's logs cannot be read right now. On the VM, journalctl still shows them.",
		}),
	);
	renderApp("/admin?tab=logs");
	expect((await screen.findByRole("alert")).textContent).toContain(
		"The platform's logs cannot be read right now.",
	);
});

test("skipped entries and a stopped scan are explained", async () => {
	stubLogs(() =>
		json(200, {
			lines: [],
			nextCursor: cursor(9),
			scanComplete: false,
			skippedLines: 3,
		}),
	);
	renderApp("/admin?tab=logs");
	expect((await screen.findByTestId("logs-skipped")).textContent).toContain(
		"3 journal entries were not a Portikus log line",
	);
	expect(screen.getByTestId("logs-partial").textContent).toBe(partialText(true));
	expect(screen.getByTestId("logs-empty")).toBeDefined();
});

test("a stopped scan with nothing to resume asks for a narrower range", async () => {
	stubLogs(() =>
		json(200, { lines: [], nextCursor: null, scanComplete: false, skippedLines: 0 }),
	);
	renderApp("/admin?tab=logs");
	expect((await screen.findByTestId("logs-partial")).textContent).toBe(
		"The search stopped at its time limit before it found a line. Narrow the time range and try again.",
	);
	expect(screen.queryByTestId("logs-older")).toBeNull();
});

test("applying filters puts them in the URL and the request", async () => {
	const requested = stubLogs(() => json(200, page([])));
	const { router } = renderApp("/admin?tab=logs");
	await screen.findByTestId("logs-empty");
	expect(screen.getByTestId("logs-level-note").textContent).toContain(
		"Debug lines exist only while the log level on the Settings tab is Debug.",
	);

	fireEvent.click(screen.getByRole("checkbox", { name: "Info" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Worker" }));
	fireEvent.change(screen.getByLabelText("Text"), { target: { value: "terminal" } });
	fireEvent.change(screen.getByLabelText("User ID"), { target: { value: ALICE } });
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	await waitFor(() =>
		expect(router.state.location.search).toMatchObject({
			tab: "logs",
			level: "error,warn,info",
			service: "api,controller",
			q: "terminal",
			user: ALICE,
		}),
	);
	await waitFor(() => expect(requested.at(-1)?.get("q")).toBe("terminal"));
	expect(requested.at(-1)?.get("level")).toBe("error,warn,info");
	expect(requested.at(-1)?.get("service")).toBe("api,controller");

	fireEvent.click(screen.getByRole("button", { name: "Clear" }));
	await waitFor(() => expect(router.state.location.search).toEqual({ tab: "logs" }));
});

test("a bad ID or no level is refused in the form", async () => {
	stubLogs(() => json(200, page([])));
	const { router } = renderApp("/admin?tab=logs");
	await screen.findByTestId("logs-empty");

	fireEvent.change(screen.getByLabelText("Workspace ID"), { target: { value: "abc" } });
	fireEvent.click(screen.getByRole("checkbox", { name: "Error" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Warn" }));
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	expect(await screen.findByText("Choose at least one level.")).toBeDefined();
	expect(
		screen.getByText("Enter a full ID, as shown in the detail panel."),
	).toBeDefined();
	expect(router.state.location.search).toEqual({ tab: "logs" });
	// Focus goes to the first bad field, so its error is heard.
	expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Error" }));

	fireEvent.click(screen.getByRole("checkbox", { name: "Error" }));
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByLabelText("Workspace ID")),
	);

	// Enter in the bad field itself: focus leaves and returns, so the error is heard again.
	const workspace = screen.getByLabelText("Workspace ID");
	const focused = vi.fn();
	workspace.addEventListener("focus", focused);
	fireEvent.submit(workspace.closest("form") as HTMLFormElement);
	expect(focused).toHaveBeenCalledTimes(1);
	expect(document.activeElement).toBe(workspace);
});
