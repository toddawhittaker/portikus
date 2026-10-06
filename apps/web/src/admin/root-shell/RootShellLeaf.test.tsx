import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { UseXtermOptions } from "../../terminal/useXterm.js";
import { LOSS_TEXT, RootShellLeaf } from "./RootShellLeaf.js";
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

vi.mock("@dnd-kit/core", () => ({
	useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, isDragging: false }),
	useDroppable: () => ({ setNodeRef: () => {} }),
}));

afterEach(() => {
	cleanup();
	sockets.length = 0;
});

function renderLeaf(onExited = vi.fn()) {
	render(
		<RootShellLeaf
			shellId="s1"
			name="Root shell 1"
			theme="dark"
			screenReaderMode={false}
			visible={true}
			focused={true}
			alone={true}
			dropEdge={null}
			moveTargets={[]}
			onFocus={vi.fn()}
			onSplit={vi.fn()}
			onMoveToNewTab={vi.fn()}
			onMoveInto={vi.fn()}
			onResetSizes={vi.fn()}
			onLeave={vi.fn()}
			onClose={vi.fn()}
			onExited={onExited}
		/>,
	);
}

test("a shell the host refused says so, and Try again opens a new socket", () => {
	renderLeaf();
	expect(sockets).toHaveLength(1);
	act(() => sockets[0]?.events.onLost("refused"));
	expect(screen.getByTestId("root-shell-refused-s1").textContent).toContain(
		LOSS_TEXT.refused,
	);
	expect(screen.getByRole("status").textContent).toBe(LOSS_TEXT.refused);

	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	expect(sockets).toHaveLength(2);
	expect(screen.queryByTestId("root-shell-refused-s1")).toBeNull();
	expect(screen.getByRole("status").textContent).toBe("");
});

test("a lost connection keeps the screen and flags it, with no retry", () => {
	renderLeaf();
	act(() => sockets[0]?.events.onLost("too_many"));
	expect(screen.getByTestId("root-shell-lost-s1").textContent).toBe(LOSS_TEXT.too_many);
	expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a shell that exits hands its pane back", () => {
	const onExited = vi.fn();
	renderLeaf(onExited);
	act(() => sockets[0]?.events.onExit());
	expect(onExited).toHaveBeenCalledWith("s1");
});
