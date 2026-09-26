import type { LogLine, LogPage } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../api/request.js";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import { levelTagClass, levelText, linesText, messageOf } from "./LogsTab.js";
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
	expect(screen.getByTestId("logs-partial")).toBeDefined();
	expect(screen.getByTestId("logs-empty")).toBeDefined();
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
});
