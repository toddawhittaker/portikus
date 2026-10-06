import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { UseXtermOptions } from "../../terminal/useXterm.js";
import { createSessionHost, LOSS_TEXT, RootShellSession } from "./RootShellSession.js";
import type { RootShellSocketEvents } from "./rootShellSocket.js";

const sockets: { events: RootShellSocketEvents; stop: ReturnType<typeof vi.fn> }[] = [];

vi.mock("./rootShellSocket.js", () => ({
	openRootShellSocket: (_size: unknown, events: RootShellSocketEvents) => {
		const socket = { events, send: vi.fn(), stop: vi.fn() };
		sockets.push(socket);
		return socket;
	},
}));

// xterm.js needs a real canvas; a stand-in terminal runs `attach` as the hook does.
vi.mock("../../terminal/useXterm.js", () => ({
	useXterm: ({ attach }: UseXtermOptions) => {
		useEffect(() => {
			const term = { cols: 80, rows: 24, onData: () => ({ dispose() {} }) };
			const session = attach(term as never, {
				container: document.createElement("div"),
				fit: () => {},
			});
			return () => session.dispose();
		}, [attach]);
	},
}));

afterEach(() => {
	cleanup();
	sockets.length = 0;
	document.body.replaceChildren();
});

function renderSession(
	handlers: { onExited?: () => void; onEndedChange?: () => void } = {},
) {
	const host = createSessionHost();
	document.body.append(host);
	const onExited = vi.fn(handlers.onExited);
	const onEndedChange = vi.fn(handlers.onEndedChange);
	const view = render(
		<RootShellSession
			shellId="s1"
			host={host}
			name="Root shell 1"
			theme="dark"
			screenReaderMode={false}
			visible={true}
			focused={true}
			onFocus={vi.fn()}
			onLeave={vi.fn()}
			onExited={onExited}
			onEndedChange={onEndedChange}
		/>,
	);
	return { host, onExited, onEndedChange, view };
}

test("the session renders into its host, which the pane adopts", () => {
	const { host } = renderSession();
	expect(host.querySelector('[data-testid="terminal-pane-s1"]')).not.toBeNull();
	expect(sockets).toHaveLength(1);
});

test("a shell the host refused says so, and Try again opens a new socket", () => {
	const { onEndedChange } = renderSession();
	act(() => sockets[0]?.events.onLost("refused"));
	expect(screen.getByTestId("root-shell-refused-s1").textContent).toContain(
		LOSS_TEXT.refused,
	);
	expect(screen.getByRole("status").textContent).toBe(LOSS_TEXT.refused);
	expect(onEndedChange).toHaveBeenLastCalledWith("s1", true);

	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	expect(sockets).toHaveLength(2);
	expect(screen.queryByTestId("root-shell-refused-s1")).toBeNull();
	expect(screen.getByRole("status").textContent).toBe("");
	expect(onEndedChange).toHaveBeenLastCalledWith("s1", false);
});

test("a lost connection keeps the screen and flags it, with no retry", () => {
	renderSession();
	act(() => sockets[0]?.events.onLost("too_many"));
	expect(screen.getByTestId("root-shell-lost-s1").textContent).toBe(LOSS_TEXT.too_many);
	expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a shell that exits hands its pane back, and unmounting hangs up", () => {
	const { onExited, view } = renderSession();
	act(() => sockets[0]?.events.onExit());
	expect(onExited).toHaveBeenCalledWith("s1");
	view.unmount();
	expect(sockets[0]?.stop).toHaveBeenCalled();
});
