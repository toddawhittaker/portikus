import { afterEach, expect, test, vi } from "vitest";
import { focusAgentInput } from "./focusAgent.js";

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

/** An agent pane as the work area draws it, shown or in a hidden tab. */
function pane(id: string, input: string, shown: boolean): HTMLElement {
	const leaf = document.createElement("div");
	leaf.dataset.testid = `terminal-leaf-${id}`;
	leaf.innerHTML = input;
	const box = leaf.querySelector("textarea, [contenteditable]") as HTMLElement;
	box.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList;
	document.body.append(leaf);
	return box;
}

test("focuses a terminal's input once its pane is on show", async () => {
	const input = pane(
		"t1",
		`<textarea class="xterm-helper-textarea"></textarea>`,
		false,
	);
	focusAgentInput("t1");
	expect(document.activeElement).not.toBe(input);
	input.getClientRects = () => [{}] as unknown as DOMRectList;
	await vi.waitFor(() => expect(document.activeElement).toBe(input));
});

test("focuses a chat's message box, not the side composer", () => {
	pane(
		"c1",
		`<textarea class="pk-side-box"></textarea><div contenteditable="true" data-testid="chat-composer-input"></div>`,
		true,
	);
	const box = document.querySelector(
		'[data-testid="chat-composer-input"]',
	) as HTMLElement;
	box.getClientRects = () => [{}] as unknown as DOMRectList;
	focusAgentInput("c1");
	expect(document.activeElement).toBe(box);
});

test("gives up when the pane never shows", () => {
	const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => {
		run(0);
		return 0;
	});
	focusAgentInput("gone");
	expect(frame).toHaveBeenCalledTimes(60);
});
