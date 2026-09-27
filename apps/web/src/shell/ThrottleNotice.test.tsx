import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { ThrottleNotice, throttleAnnouncement } from "./ThrottleNotice.js";

test("says why the workspace is slow, with the numbers from the row", () => {
	const onDismiss = vi.fn();
	const onOpenWorkspace = vi.fn();
	const onShowMonitor = vi.fn();
	render(
		<ThrottleNotice
			throttle={{
				at: "2026-09-25T12:00:00.000Z",
				thresholdPercent: 70,
				windowMinutes: 45,
				sharePercent: 50,
				idleLiftMinutes: null,
				idleLiftPercent: null,
			}}
			onDismiss={onDismiss}
			onOpenWorkspace={onOpenWorkspace}
			onShowMonitor={onShowMonitor}
		/>,
	);

	const notice = screen.getByTestId("throttle-notice");
	expect(notice.textContent).toContain("Your workspace has been slowed down");
	expect(notice.textContent).toContain("more than 70% busy for 45 minutes");
	expect(notice.textContent).toContain("it now gets 50% of its usual CPU");
	expect(notice.textContent).toContain("Stopping and starting the workspace");

	fireEvent.click(
		screen.getByRole("button", { name: "Dismiss the slowed-down notice" }),
	);
	expect(onDismiss).toHaveBeenCalledTimes(1);

	fireEvent.click(screen.getByRole("button", { name: "Restart workspace…" }));
	expect(onOpenWorkspace).toHaveBeenCalledTimes(1);

	fireEvent.click(screen.getByRole("button", { name: "See what's using CPU" }));
	expect(onShowMonitor).toHaveBeenCalledTimes(1);
	expect(notice.textContent).not.toContain("on its own");
});

test("says when the throttle lifts on its own, when lifting is on", () => {
	render(
		<ThrottleNotice
			throttle={{
				at: "2026-09-25T12:00:00.000Z",
				thresholdPercent: 70,
				windowMinutes: 45,
				sharePercent: 50,
				idleLiftMinutes: 5,
				idleLiftPercent: 10,
			}}
			onDismiss={() => {}}
			onOpenWorkspace={() => {}}
			onShowMonitor={() => {}}
		/>,
	);
	expect(screen.getByTestId("throttle-notice").textContent).toContain(
		"It returns to full speed on its own after 5 minutes under 10% use.",
	);
});

test("the notice is not itself a live region; the page's status region carries the words", () => {
	const throttle = {
		at: "2026-09-25T12:00:00.000Z",
		thresholdPercent: 70,
		windowMinutes: 45,
		sharePercent: 50,
		idleLiftMinutes: null,
		idleLiftPercent: null,
	};
	render(
		<ThrottleNotice
			throttle={throttle}
			onDismiss={() => {}}
			onOpenWorkspace={() => {}}
			onShowMonitor={() => {}}
		/>,
	);
	expect(screen.getByTestId("throttle-notice").getAttribute("role")).toBeNull();
	expect(throttleAnnouncement(throttle)).toBe(
		"Your workspace has been slowed down. It kept its CPUs more than 70% busy for 45 minutes, so it now gets 50% of its usual CPU. Stopping and starting the workspace restores full speed; an administrator can also lift this.",
	);
});

test("a held throttle says a restart keeps it slowed, and why (SPEC.md §19.4)", () => {
	const text = throttleAnnouncement({
		at: "2026-09-25T12:00:00.000Z",
		thresholdPercent: 80,
		windowMinutes: 30,
		sharePercent: 25,
		idleLiftMinutes: 5,
		idleLiftPercent: 10,
		held: { count: 3, hours: 24 },
	});
	expect(text).toContain(
		"It stays slowed after a restart because it was slowed 3 times in the last 24 hours.",
	);
	expect(text).toContain("after 5 minutes under 10% use");
	expect(text).not.toContain("Stopping and starting the workspace restores full speed");
});

test("focus goes to the work area when the throttle lifts while the notice has focus", () => {
	function Page({ shown }: { shown: boolean }) {
		const work = useRef<HTMLElement>(null);
		return (
			<>
				<main ref={work} tabIndex={-1} data-testid="work" />
				{shown ? (
					<ThrottleNotice
						throttle={{
							at: "2026-09-25T12:00:00.000Z",
							thresholdPercent: 80,
							windowMinutes: 30,
							sharePercent: 25,
							idleLiftMinutes: null,
							idleLiftPercent: null,
						}}
						onDismiss={() => {}}
						onOpenWorkspace={() => {}}
						onShowMonitor={() => {}}
						fallbackFocus={work}
					/>
				) : null}
			</>
		);
	}
	const view = render(<Page shown />);
	screen.getByRole("button", { name: "See what's using CPU" }).focus();
	view.rerender(<Page shown={false} />);
	expect(document.activeElement).toBe(screen.getByTestId("work"));
});
