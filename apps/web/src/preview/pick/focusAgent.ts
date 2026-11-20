/**
 * After a pick reaches an agent, the keyboard goes to that agent's input
 * (SPEC.md §25.8). The view switch only changes the route, and a terminal or
 * chat takes the keyboard only when it first mounts, so this waits for the
 * agent's pane to be on show and focuses its input itself.
 */

/** The terminal's input, or the chat's message box; never the side composer. */
const INPUT = '.xterm-helper-textarea, [data-testid="chat-composer-input"]';

/** About a second of frames, enough for the route change and the pane to draw. */
const MAX_FRAMES = 60;

function inputOf(terminalId: string): HTMLElement | null {
	const pane = document.querySelector(
		`[data-testid="terminal-leaf-${CSS.escape(terminalId)}"]`,
	);
	const input = pane?.querySelector<HTMLElement>(INPUT) ?? null;
	// A pane in a hidden tab has no box, and focus there would go nowhere.
	return input && input.getClientRects().length > 0 ? input : null;
}

/** Focuses the agent's input once it is on show; gives up after about a second. */
export function focusAgentInput(terminalId: string, frames = MAX_FRAMES): void {
	const input = inputOf(terminalId);
	if (input) {
		input.focus({ preventScroll: true });
		return;
	}
	if (frames > 0) requestAnimationFrame(() => focusAgentInput(terminalId, frames - 1));
}
