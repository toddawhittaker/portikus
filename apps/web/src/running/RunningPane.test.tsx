/**
 * The Running surface (SPEC.md §18.2): what each row says, which ports
 * offer a preview, and how a saved preview with no listener is marked.
 */
import type { ListeningService } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunningPane } from "./RunningPane.js";
import { ListeningContext } from "./services.js";

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

function show(
	services: ListeningService[],
	options: { previewPorts?: number[]; onOpenPreview?: (port: number) => void } = {},
) {
	render(
		<ListeningContext.Provider value={{ services, loaded: true }}>
			<RunningPane
				previewPorts={options.previewPorts ?? []}
				onOpenPreview={options.onOpenPreview ?? (() => {})}
			/>
		</ListeningContext.Provider>,
	);
}

afterEach(cleanup);

test("an empty workspace says nothing is running yet", () => {
	show([]);
	expect(screen.getByText("Nothing is running yet")).toBeTruthy();
});

test("a row names the port, the command and whether it is Docker", () => {
	show([
		service({ port: 3000 }),
		service({
			port: 5432,
			process: { command: "postgres" },
			container: { id: "abc", name: "postgres" },
		}),
	]);
	expect(screen.getByTestId("running-row-3000").textContent).toContain("node");
	expect(screen.getByTestId("running-row-3000").textContent).toContain("Preview");
	expect(screen.getByTestId("running-row-5432").textContent).toContain("Docker");
});

test("ports are listed lowest first", () => {
	show([service({ port: 8000 }), service({ port: 3000 })]);
	const ports = [...screen.getByTestId("running-list").querySelectorAll(".pk-portrow")]
		.map((row) => row.textContent?.slice(0, 4))
		.filter(Boolean);
	expect(ports[0]).toBe("3000");
	expect(ports[1]).toBe("8000");
});

test("Open preview opens the port it names", () => {
	const onOpenPreview = vi.fn();
	show([service({ port: 3000 })], { onOpenPreview });
	fireEvent.click(screen.getByTestId("running-open-3000"));
	expect(onOpenPreview).toHaveBeenCalledWith(3000);
});

test("a port policy denies offers no preview", () => {
	// The API owns the port policy and reports it as previewReachability;
	// the pane does not keep a copy of the rules.
	show([service({ port: 3000, previewReachability: "denied" })]);
	expect(screen.queryByTestId("running-open-3000")).toBeNull();
});

test("a saved preview whose port stopped is marked as not running", () => {
	show([service({ port: 3000 })], { previewPorts: [3000, 5173] });
	expect(screen.queryByTestId("running-stale-3000")).toBeNull();
	expect(screen.getByTestId("running-stale-5173").textContent).toContain("not running");
});
