/**
 * The browser-open confirmation (BROWSER-HANDLING.md §18, §19.1, §21.2, §25.2).
 */
import type { BrowserOpenRequest } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BrowserOpenDialog } from "./BrowserOpenDialog.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

function request(partial: Partial<BrowserOpenRequest> = {}): BrowserOpenRequest {
	return {
		type: "browser.open.request",
		requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		workspaceId: WORKSPACE,
		url: "https://example.com/login?code=secret",
		brokerClass: "external",
		requestedAt: "2026-01-01T00:00:00.000Z",
		...partial,
	};
}

function show(frame: BrowserOpenRequest, onOpenPreview = vi.fn()) {
	const onClose = vi.fn();
	render(
		<BrowserOpenDialog
			request={frame}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			onOpenPreview={onOpenPreview}
			onClose={onClose}
		/>,
	);
	return { onClose, onOpenPreview };
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("the dialog shows the true origin and the executable", () => {
	show(
		request({
			source: { executable: "/usr/bin/codex" },
		}),
	);
	expect(screen.getByTestId("browser-open-origin").textContent).toBe(
		"https://example.com",
	);
	expect(screen.getByTestId("browser-open-executable").textContent).toContain(
		"/usr/bin/codex",
	);
});

test("plain HTTP that is not loopback is warned about", () => {
	show(request({ url: "http://example.com/start" }));
	expect(screen.getByTestId("browser-open-origin").textContent).toBe(
		"http://example.com",
	);
	expect(screen.getByTestId("browser-open-http-warning").textContent).toContain(
		"plain HTTP",
	);
});

test("Open runs only after the click, and Copy and Cancel stay on the page", async () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const frame = request();
	show(frame);

	expect(open).not.toHaveBeenCalled();
	fireEvent.click(screen.getByTestId("browser-open-confirm"));
	expect(open).toHaveBeenCalledTimes(1);
	expect(open).toHaveBeenCalledWith(frame.url, "_blank", "noopener,noreferrer");

	cleanup();
	open.mockClear();
	const copied = show(frame);
	fireEvent.click(screen.getByTestId("browser-open-copy"));
	expect(open).not.toHaveBeenCalled();
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(frame.url));
	await waitFor(() => expect(copied.onClose).toHaveBeenCalled());

	cleanup();
	const cancelled = show(frame);
	fireEvent.click(screen.getByTestId("browser-open-cancel"));
	expect(open).not.toHaveBeenCalled();
	expect(cancelled.onClose).toHaveBeenCalled();
});

test("a javascript URL never reaches Open", () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	show(request({ url: "javascript:alert(1)", brokerClass: "external" }));
	expect(screen.queryByTestId("browser-open-confirm")).toBeNull();
	expect(screen.getByTestId("browser-open-rejected")).toBeTruthy();
	expect(open).not.toHaveBeenCalled();
});

test("a loopback login names the device-auth command and opens nothing", () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	const onOpenPreview = vi.fn();
	show(
		request({
			url: "http://127.0.0.1:43127/callback",
			brokerClass: "loopback-login",
		}),
		onOpenPreview,
	);
	expect(screen.getByTestId("browser-open-login").textContent).toContain(
		"cannot receive a callback on localhost",
	);
	expect(screen.getByTestId("browser-open-login").textContent).toContain(
		"codex login --device-auth",
	);
	expect(screen.queryByTestId("browser-open-confirm")).toBeNull();
	expect(open).not.toHaveBeenCalled();
	expect(onOpenPreview).not.toHaveBeenCalled();
});

test("a loopback preview opens the existing preview and not a new tab", () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	const onOpenPreview = vi.fn();
	show(
		request({
			url: "http://127.0.0.1:5173/app",
			brokerClass: "loopback-preview",
		}),
		onOpenPreview,
	);
	expect(open).not.toHaveBeenCalled();
	fireEvent.click(screen.getByTestId("browser-open-confirm"));
	expect(onOpenPreview).toHaveBeenCalledWith(5173);
	expect(open).not.toHaveBeenCalled();
});
