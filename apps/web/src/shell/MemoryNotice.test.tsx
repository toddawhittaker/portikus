import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { MemoryNotice, memoryAnnouncement } from "./MemoryNotice.js";

const FLAG = {
	at: "2026-09-26T12:00:00.000Z",
	averagePercent: 93,
	thresholdPercent: 90,
	windowMinutes: 10,
};

test("says the workspace has been near its memory limit, with the flag's numbers", () => {
	const onDismiss = vi.fn();
	const onShowMonitor = vi.fn();
	render(
		<MemoryNotice flag={FLAG} onDismiss={onDismiss} onShowMonitor={onShowMonitor} />,
	);

	const notice = screen.getByTestId("memory-notice");
	expect(notice.textContent).toContain("Your workspace has been near its memory limit");
	expect(notice.textContent).toContain(
		"For 10 minutes it used more than 90% of its memory. If it runs out, the biggest program is stopped.",
	);
	expect(notice.getAttribute("role")).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "See what's using memory" }));
	expect(onShowMonitor).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByRole("button", { name: "Dismiss the memory notice" }));
	expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("the announcement carries the title and the body", () => {
	expect(memoryAnnouncement(FLAG)).toBe(
		"Your workspace has been near its memory limit. For 10 minutes it used more than 90% of its memory. If it runs out, the biggest program is stopped.",
	);
});

function Page({ shown }: { shown: boolean }) {
	const work = useRef<HTMLElement>(null);
	return (
		<>
			<main ref={work} tabIndex={-1} data-testid="work" />
			<button type="button">elsewhere</button>
			{shown ? (
				<MemoryNotice
					flag={FLAG}
					onDismiss={() => {}}
					onShowMonitor={() => {}}
					fallbackFocus={work}
				/>
			) : null}
		</>
	);
}

test("focus goes to the work area when the notice goes away on its own while focused", () => {
	const view = render(<Page shown />);
	screen.getByRole("button", { name: "See what's using memory" }).focus();
	view.rerender(<Page shown={false} />);
	expect(document.activeElement).toBe(screen.getByTestId("work"));
});

test("focus elsewhere stays put when the notice goes away", () => {
	const view = render(<Page shown />);
	screen.getByRole("button", { name: "elsewhere" }).focus();
	view.rerender(<Page shown={false} />);
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: "elsewhere" }),
	);
});

test("a notice that never had focus leaves focus on the page alone when it goes", () => {
	const view = render(<Page shown />);
	(document.activeElement as HTMLElement | null)?.blur();
	expect(document.activeElement).toBe(document.body);
	view.rerender(<Page shown={false} />);
	expect(document.activeElement).toBe(document.body);
});
