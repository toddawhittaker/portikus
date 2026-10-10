import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PaneFrame, type PaneFrameProps } from "./PaneFrame";

afterEach(cleanup);

function frameProps(): PaneFrameProps {
	return {
		terminalId: "t1",
		name: "root",
		title: "root · /",
		focused: false,
		ended: false,
		alone: false,
		moveTargets: [],
		onFocus: vi.fn(),
		onSplit: vi.fn(),
		onMoveToNewTab: vi.fn(),
		onMoveInto: vi.fn(),
		onResetSizes: vi.fn(),
		onLeave: vi.fn(),
		onClose: vi.fn(),
		children: <p data-testid="inside">shell</p>,
	};
}

function renderFrame(overrides: Partial<PaneFrameProps> = {}) {
	const props: PaneFrameProps = { ...frameProps(), ...overrides };
	render(<PaneFrame {...props} />);
	return props;
}

function openMenu() {
	fireEvent.pointerDown(screen.getByTestId("terminal-actions-t1"), {
		button: 0,
		ctrlKey: false,
	});
}

test("the frame shows its title and holds what it is given", () => {
	renderFrame();
	expect(screen.getByText("root · /")).toBeTruthy();
	expect(screen.getByTestId("inside")).toBeTruthy();
	expect(screen.getByLabelText("Terminal: root · /")).toBeTruthy();
});

test("without rename or theme actions the menu offers neither", async () => {
	const props = renderFrame();
	openMenu();
	expect(screen.queryByTestId("terminal-rename")).toBeNull();
	expect(screen.queryByTestId("terminal-theme-toggle")).toBeNull();
	fireEvent.click(screen.getByTestId("terminal-close"));
	// Once the menu has closed, so the caller can move the keyboard on.
	await waitFor(() => expect(props.onClose).toHaveBeenCalledWith("t1"));
});

test("given rename and theme actions, the menu offers both", () => {
	const props = renderFrame({ onRename: vi.fn(), onSetTheme: vi.fn(), theme: "dark" });
	openMenu();
	fireEvent.click(screen.getByTestId("terminal-theme-toggle"));
	expect(props.onSetTheme).toHaveBeenCalledWith("t1", "light");
	openMenu();
	fireEvent.click(screen.getByTestId("terminal-rename"));
	const field = screen.getByTestId("terminal-rename-field");
	fireEvent.change(field, { target: { value: "admin" } });
	fireEvent.keyDown(field, { key: "Enter" });
	expect(props.onRename).toHaveBeenCalledWith("t1", "admin");
});

test("an ended pane cannot be split, and a lone pane cannot move to a new tab", () => {
	renderFrame({ ended: true, alone: true });
	openMenu();
	const disabled = (id: string) =>
		screen.getByTestId(id).closest("[role='menuitem']")?.getAttribute("data-disabled");
	expect(disabled("split-right")).not.toBeNull();
	expect(disabled("terminal-move-to-new-tab")).not.toBeNull();
});

test("a drop zone is shaded on the edge a drag would land", () => {
	renderFrame({ dropEdge: "left" });
	expect(screen.getByTestId("drop-zone-t1").getAttribute("data-edge")).toBe("left");
});

function voice(state: "unsupported" | "idle" | "listening" | "error" = "idle") {
	return {
		state,
		interim: "",
		message: "",
		start: vi.fn(),
		stop: vi.fn(),
		explain: vi.fn(),
	};
}

test("the microphone listens only while it is held", () => {
	const speech = voice();
	renderFrame({ voice: speech });
	const button = screen.getByTestId("terminal-voice-t1");
	expect(button.getAttribute("aria-pressed")).toBe("false");
	fireEvent.pointerDown(button, { button: 0 });
	expect(speech.start).toHaveBeenCalledTimes(1);
	fireEvent.pointerUp(button);
	expect(speech.stop).toHaveBeenCalled();
	// A click alone starts nothing more.
	fireEvent.click(button);
	expect(speech.start).toHaveBeenCalledTimes(1);
});

test("Space held on the microphone listens until it is released", () => {
	const speech = voice();
	renderFrame({ voice: speech });
	const button = screen.getByTestId("terminal-voice-t1");
	fireEvent.keyDown(button, { key: " " });
	fireEvent.keyDown(button, { key: " ", repeat: true });
	expect(speech.start).toHaveBeenCalledTimes(1);
	fireEvent.keyUp(button, { key: " " });
	expect(speech.stop).toHaveBeenCalled();
});

test("while listening the button is pressed and interim words show", () => {
	renderFrame({
		voice: { ...voice("listening"), interim: "git sta", message: "Listening…" },
	});
	expect(screen.getByTestId("terminal-voice-t1").getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(screen.getByTestId("terminal-voice-interim-t1").textContent).toBe("git sta");
	expect(screen.getByTestId("terminal-voice-status-t1").textContent).toBe("Listening…");
});

test("an unsupported browser shows no microphone", () => {
	renderFrame({ voice: voice("unsupported") });
	expect(screen.queryByTestId("terminal-voice-t1")).toBeNull();
});

test("the status region is a polite live region", () => {
	renderFrame({ voice: voice() });
	expect(screen.getByTestId("terminal-voice-status-t1").getAttribute("aria-live")).toBe(
		"polite",
	);
});

test("an error is shown as well as announced", () => {
	renderFrame({ voice: { ...voice("error"), message: "No microphone was found." } });
	expect(screen.getByTestId("terminal-voice-error-t1").textContent).toBe(
		"No microphone was found.",
	);
	expect(screen.getByTestId("terminal-voice-status-t1").textContent).toBe(
		"No microphone was found.",
	);
});

test("an unsupported browser still announces why the microphone went away", () => {
	renderFrame({
		voice: {
			...voice("unsupported"),
			message: "Voice input is not available in this browser.",
		},
	});
	expect(screen.getByTestId("terminal-voice-status-t1").textContent).toBe(
		"Voice input is not available in this browser.",
	);
});

test("losing support while the microphone has focus moves focus to the terminal", () => {
	const terminal = (
		<textarea className="xterm-helper-textarea" data-testid="xterm-input" />
	);
	const { rerender } = render(
		<PaneFrame {...frameProps()} voice={voice()}>
			{terminal}
		</PaneFrame>,
	);
	screen.getByTestId("terminal-voice-t1").focus();
	rerender(
		<PaneFrame {...frameProps()} voice={voice("unsupported")}>
			{terminal}
		</PaneFrame>,
	);
	expect(document.activeElement).toBe(screen.getByTestId("xterm-input"));
});

test("a click with no pointer press explains how to hold", () => {
	const speech = voice();
	renderFrame({ voice: speech });
	fireEvent.click(screen.getByTestId("terminal-voice-t1"), { detail: 0 });
	expect(speech.explain).toHaveBeenCalledWith(
		"Hold Space on this button, or Alt+Shift+M in the terminal, to talk.",
	);
	expect(speech.start).not.toHaveBeenCalled();
});

test("a mouse click does not explain", () => {
	const speech = voice();
	renderFrame({ voice: speech });
	fireEvent.click(screen.getByTestId("terminal-voice-t1"), { detail: 1 });
	expect(speech.explain).not.toHaveBeenCalled();
});

test("Alt+Shift+M held on the microphone listens until it is released", () => {
	const speech = voice();
	renderFrame({ voice: speech });
	const button = screen.getByTestId("terminal-voice-t1");
	fireEvent.keyDown(button, { key: "M", code: "KeyM", altKey: true, shiftKey: true });
	expect(speech.start).toHaveBeenCalledTimes(1);
});
