/**
 * The `+ Preview` launcher (SPEC.md §14.6, §14.7): the ports it offers and
 * the ports it refuses.
 */
import type { ListeningService } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ListeningContext } from "../running/services.js";
import { PreviewPicker, portError } from "./PreviewPicker.js";

function service(over: Partial<ListeningService>): ListeningService {
	return {
		workspaceId: "22222222-2222-4222-8222-222222222222",
		port: 3000,
		addresses: ["0.0.0.0"],
		protocolHint: "http",
		process: { pid: 7, command: "node" },
		previewReachability: "reachable",
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

afterEach(cleanup);

test.each([
	["", "Enter a port number."],
	["abc", "Enter a port number."],
	["80", "Ports below 1024 are reserved. Run your application on a higher port."],
	["70000", "Ports go up to 65535."],
	["65536", "Ports go up to 65535."],
])("the port %s is refused", (text, message) => {
	expect(portError(text)).toBe(message);
});

test("an ordinary development port is accepted", () => {
	expect(portError("5173")).toBeNull();
});

test("choosing a listening port opens it", () => {
	const onOpen = vi.fn();
	show([service({ port: 5173 })], onOpen);
	fireEvent.click(screen.getByTestId("preview-port-5173"));
	expect(onOpen).toHaveBeenCalledWith(5173);
});

test("a denied or reserved port is not offered", () => {
	show(
		[service({ port: 80 }), service({ port: 3000, previewReachability: "denied" })],
		vi.fn(),
	);
	expect(screen.queryByTestId("preview-port-80")).toBeNull();
	expect(screen.queryByTestId("preview-port-3000")).toBeNull();
	expect(screen.getByText("Nothing is listening yet.")).toBeTruthy();
});

test("a typed port opens when it is allowed", () => {
	const onOpen = vi.fn();
	show([], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "4200" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).toHaveBeenCalledWith(4200);
});

test("a typed port below 1024 explains itself instead of opening", () => {
	const onOpen = vi.fn();
	show([], onOpen);
	fireEvent.change(screen.getByLabelText("Port"), { target: { value: "80" } });
	fireEvent.click(screen.getByTestId("preview-open-port"));
	expect(onOpen).not.toHaveBeenCalled();
	expect(
		screen.getByText(
			"Ports below 1024 are reserved. Run your application on a higher port.",
		),
	).toBeTruthy();
});
