import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	REVEAL_TIMEOUT_MS,
	requestToolReveal,
	revealTool,
	useToolReveal,
} from "./revealTool";

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

/** A tool row inside a tool group inside a folded turn, all closed. */
const FOLDED = `
	<details data-testid="chat-worked"><summary>Worked for 2m</summary>
		<details class="pk-turn-group"><summary>3 tool calls</summary>
			<details data-testid="chat-tool-toolu_1"><summary>Agent</summary><p>result</p></details>
		</details>
	</details>`;

test("opens the folded sections around a tool row and the row, then focuses it", () => {
	document.body.innerHTML = FOLDED;
	expect(revealTool(document, "toolu_1")).toBe(true);
	for (const details of document.querySelectorAll("details")) {
		expect(details.open).toBe(true);
	}
	const summary = document.querySelector('[data-testid="chat-tool-toolu_1"] > summary');
	expect(document.activeElement).toBe(summary);
	expect(summary?.scrollIntoView).toHaveBeenCalled();
});

test("asked not to take the keyboard, it opens and scrolls to the row but leaves focus alone", () => {
	document.body.innerHTML = `${FOLDED}<button type="button">elsewhere</button>`;
	const elsewhere = document.querySelector("button");
	elsewhere?.focus();
	expect(revealTool(document, "toolu_1", false)).toBe(true);
	const row = document.querySelector<HTMLDetailsElement>(
		'[data-testid="chat-tool-toolu_1"]',
	);
	expect(row?.open).toBe(true);
	expect(document.activeElement).toBe(elsewhere);
});

test("a row that is not there yet is reported, and nothing opens", () => {
	document.body.innerHTML = FOLDED;
	expect(revealTool(document, "toolu_9")).toBe(false);
	expect(document.querySelector("details")?.open).toBe(false);
});

function Chat({
	terminalId,
	visible,
	rows,
}: {
	terminalId: string;
	visible: boolean;
	rows: string[];
}) {
	const root = useRef<HTMLDivElement | null>(null);
	useToolReveal(terminalId, root, visible, rows, true);
	return (
		<div ref={root}>
			{rows.map((id) => (
				<details key={id} data-testid={`chat-tool-${id}`}>
					<summary>{id}</summary>
				</details>
			))}
		</div>
	);
}

test("a request waits for its chat to be shown and its row to arrive, then runs once", () => {
	const { rerender, getByTestId } = render(
		<Chat terminalId="t1" visible={false} rows={[]} />,
	);
	act(() => requestToolReveal("t1", "toolu_a"));
	rerender(<Chat terminalId="t1" visible={false} rows={["toolu_a"]} />);
	expect((getByTestId("chat-tool-toolu_a") as HTMLDetailsElement).open).toBe(false);

	rerender(<Chat terminalId="t1" visible={true} rows={["toolu_a"]} />);
	const row = getByTestId("chat-tool-toolu_a") as HTMLDetailsElement;
	expect(row.open).toBe(true);

	// Done is done: the student can close it again and it stays closed.
	row.open = false;
	rerender(<Chat terminalId="t1" visible={true} rows={["toolu_a", "toolu_b"]} />);
	expect(row.open).toBe(false);
});

test("a request is for its own chat only", () => {
	const { getByTestId } = render(
		<Chat terminalId="t2" visible={true} rows={["toolu_c"]} />,
	);
	act(() => requestToolReveal("t3", "toolu_c"));
	expect((getByTestId("chat-tool-toolu_c") as HTMLDetailsElement).open).toBe(false);
});

test("a request for a row that never arrives is dropped after the time limit", () => {
	vi.useFakeTimers();
	try {
		const { getByTestId, rerender } = render(
			<Chat terminalId="t4" visible={true} rows={["toolu_x"]} />,
		);
		const find = vi.spyOn(Element.prototype, "querySelector");
		act(() => requestToolReveal("t4", "toolu_gone"));
		act(() => {
			vi.advanceTimersByTime(REVEAL_TIMEOUT_MS + 1);
		});
		find.mockClear();
		// Later snapshots no longer look for the row, and a row of that id is left alone.
		rerender(<Chat terminalId="t4" visible={true} rows={["toolu_x", "toolu_gone"]} />);
		expect(find).not.toHaveBeenCalled();
		expect((getByTestId("chat-tool-toolu_gone") as HTMLDetailsElement).open).toBe(
			false,
		);
		find.mockRestore();
	} finally {
		vi.useRealTimers();
	}
});

test("a newer request restarts the time limit", () => {
	vi.useFakeTimers();
	try {
		const { getByTestId, rerender } = render(
			<Chat terminalId="t5" visible={true} rows={[]} />,
		);
		act(() => requestToolReveal("t5", "toolu_old"));
		act(() => {
			vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 1000);
		});
		act(() => requestToolReveal("t5", "toolu_new"));
		act(() => {
			vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 1000);
		});
		rerender(<Chat terminalId="t5" visible={true} rows={["toolu_new"]} />);
		expect((getByTestId("chat-tool-toolu_new") as HTMLDetailsElement).open).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
