/**
 * The `+ Preview` launcher (SPEC.md §14.6, §14.7): the ports it offers and
 * the ports it refuses.
 */
import type { ListeningService } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ListeningContext, writeShowSystem } from "../running/services.js";
import { PreviewPicker, portError } from "./PreviewPicker.js";

function service(over: Partial<ListeningService>): ListeningService {
	return {
		workspaceId: "22222222-2222-4222-8222-222222222222",
		port: 3000,
		addresses: ["0.0.0.0"],
		protocolHint: "http",
		process: { pid: 7, command: "node" },
		previewReachability: "reachable",
		system: false,
		observedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

function show(services: ListeningService[], onOpen: (port: number) => void) {
	render(
		<ListeningContext.Provider value={{ services, loaded: true }}>
			<PreviewPicker onOpen={onOpen} onClose={() => {}} />
		</ListeningContext.Provider>,
	);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(cleanup);

test.each([
	["", "Enter a port number."],
	["abc", "Enter a port number."],
	["0", "Ports go from 1 to 65535."],
	["70000", "Ports go from 1 to 65535."],
	["65536", "Ports go from 1 to 65535."],
])("the port %s is refused", (text, message) => {
	expect(portError(text)).toBe(message);
});

test("an ordinary development port is accepted", () => {
	expect(portError("5173")).toBeNull();
});

test("a low port is left to the server's own policy", () => {
	// PREVIEW_PORT_MIN, PREVIEW_PORT_MAX and PREVIEW_DENIED_PORTS live in the
	// API. Copying them here would put two policies out of step, so the
	// launcher opens the tab and the API's 403 sentence explains the refusal.
	expect(portError("80")).toBeNull();
});

test("choosing a listening port opens it", () => {
	const onOpen = vi.fn();
	show([service({ port: 5173 })], onOpen);
	fireEvent.click(screen.getByTestId("preview-port-5173"));
	expect(onOpen).toHaveBeenCalledWith(5173);
});

test("a port the server marked denied is not offered", () => {
	show([service({ port: 3000, previewReachability: "denied" })], vi.fn());
	expect(screen.queryByTestId("preview-port-3000")).toBeNull();
	expect(screen.getByText("Nothing is listening yet.")).toBeTruthy();
});

test("a low port the server did not deny is still offered", () => {
	// Whether port 80 may be previewed is the API's call, and it says so in
	// previewReachability. The launcher does not second-guess it.
	show([service({ port: 80 })], vi.fn());
	expect(screen.getByTestId("preview-port-80")).toBeTruthy();
});

test("a typed port opens when it is allowed", () => {
	const onOpen = vi.fn();
	show([], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "4200" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).toHaveBeenCalledWith(4200);
});

test("a typed port that is not a port number explains itself instead of opening", () => {
	const onOpen = vi.fn();
	show([], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).not.toHaveBeenCalled();
	expect(screen.getByText("Ports go from 1 to 65535.")).toBeTruthy();
});

test("a typed port the server may refuse is still opened", () => {
	const onOpen = vi.fn();
	show([], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "80" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).toHaveBeenCalledWith(80);
});

test("a system service is hidden unless Running is showing them", () => {
	show(
		[
			service({ port: 5173 }),
			service({ port: 5355, system: true, process: { command: "systemd-resolve" } }),
		],
		vi.fn(),
	);
	expect(screen.getByTestId("preview-port-5173")).toBeTruthy();
	expect(screen.queryByTestId("preview-port-5355")).toBeNull();
});

test("a system service is offered when Running is showing them", () => {
	writeShowSystem(true);
	show(
		[service({ port: 5355, system: true, process: { command: "systemd-resolve" } })],
		vi.fn(),
	);
	expect(screen.getByTestId("preview-port-5355")).toBeTruthy();
});

test("a denied port stays hidden even when system services are shown", () => {
	writeShowSystem(true);
	show([service({ port: 5355, system: true, previewReachability: "denied" })], vi.fn());
	expect(screen.queryByTestId("preview-port-5355")).toBeNull();
	expect(screen.getByText("Nothing is listening yet.")).toBeTruthy();
});

test("typing a hidden system port still opens it", () => {
	const onOpen = vi.fn();
	show([service({ port: 5355, system: true })], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "5355" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).toHaveBeenCalledWith(5355);
});
