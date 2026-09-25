import type { Workspace } from "@portikus/contracts";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE } from "../test-utils.js";
import { IdleNotice, idleMinutes, useIdleStopReason } from "./IdleNotice.js";

const LAST = "2026-09-25T12:00:00.000Z";
const STOP = "2026-09-25T13:05:00.000Z";

test("the idle time is the gap before the stop, less the five minutes to answer", () => {
	expect(idleMinutes({ lastActivityAt: LAST, idleStopAt: STOP })).toBe(60);
	expect(idleMinutes({ lastActivityAt: null, idleStopAt: STOP })).toBeNull();
	expect(idleMinutes({ lastActivityAt: LAST, idleStopAt: null })).toBeNull();
});

test("asks Still working?, counts down, and Keep working has focus and answers", () => {
	const onKeepWorking = vi.fn();
	const deadline = new Date(Date.now() + 4 * 60_000 + 30_000).toISOString();
	render(<IdleNotice deadline={deadline} minutes={60} onKeepWorking={onKeepWorking} />);

	const notice = screen.getByTestId("idle-notice");
	expect(notice.textContent).toContain("Still working?");
	expect(notice.textContent).toContain("will stop in 5 minutes");
	expect(notice.textContent).toContain("nothing has happened in it for 60 minutes");
	expect(notice.textContent).toContain(
		"running terminals, agents and previews will end",
	);

	const button = screen.getByRole("button", { name: "Keep working" });
	expect(document.activeElement).toBe(button);
	fireEvent.click(button);
	expect(onKeepWorking).toHaveBeenCalledTimes(1);
});

test("without an activity time it still explains the stop", () => {
	const deadline = new Date(Date.now() + 60_000).toISOString();
	render(<IdleNotice deadline={deadline} minutes={null} onKeepWorking={() => {}} />);
	expect(screen.getByTestId("idle-notice").textContent).toContain(
		"nothing has happened in it for a while",
	);
	expect(screen.getByTestId("idle-notice").textContent).toContain("stop in 1 minute,");
});

afterEach(() => {
	vi.useRealTimers();
});

/** Runs the steps with the clock at `now`, the idle deadline by default. */
function reasonAfter(steps: Partial<Workspace>[], now = STOP) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
	const hook = renderHook(
		({ workspace }: { workspace: Workspace }) => useIdleStopReason(workspace),
		{ initialProps: { workspace: WORKSPACE as Workspace } },
	);
	for (const step of steps) {
		hook.rerender({ workspace: { ...(WORKSPACE as Workspace), ...step } });
	}
	return hook.result.current;
}

test("a stop after an unanswered notice is remembered with its minutes", () => {
	expect(
		reasonAfter([
			{ idleStopAt: STOP, lastActivityAt: LAST },
			{ state: "stopping", desiredState: "stopped", idleStopAt: null },
		]),
	).toEqual({ minutes: 60 });
	// The stop time may still be set when the stop is reported.
	expect(
		reasonAfter([
			{
				idleStopAt: STOP,
				lastActivityAt: LAST,
				state: "stopped",
				desiredState: "stopped",
			},
		]),
	).toEqual({ minutes: 60 });
});

test("an answered notice, or a plain stop, gives no reason", () => {
	expect(
		reasonAfter([
			{ idleStopAt: STOP, lastActivityAt: LAST },
			{ idleStopAt: null },
			{ state: "stopped", desiredState: "stopped" },
		]),
	).toBeUndefined();
	expect(reasonAfter([{ state: "stopped", desiredState: "stopped" }])).toBeUndefined();
});

test("starting again forgets the reason", () => {
	expect(
		reasonAfter([
			{ idleStopAt: STOP, lastActivityAt: LAST },
			{ state: "stopped", desiredState: "stopped", idleStopAt: null },
			{ state: "running", desiredState: "running" },
		]),
	).toBeUndefined();
});

test("a stop well before the idle deadline is not called an idle stop", () => {
	// The student pressed Stop, or the grace period ran out, while the notice showed.
	expect(
		reasonAfter(
			[
				{ idleStopAt: STOP, lastActivityAt: LAST },
				{ state: "stopping", desiredState: "stopped" },
				{ state: "stopped", desiredState: "stopped" },
			],
			"2026-09-25T13:02:00.000Z",
		),
	).toBeUndefined();
});

test("focus returns to where it was when the notice goes", () => {
	const input = document.createElement("input");
	document.body.append(input);
	input.focus();
	const deadline = new Date(Date.now() + 60_000).toISOString();
	const view = render(
		<IdleNotice deadline={deadline} minutes={1} onKeepWorking={() => {}} />,
	);
	expect(document.activeElement).toBe(screen.getByTestId("idle-keep-working"));
	view.unmount();
	expect(document.activeElement).toBe(input);
	input.remove();
});

test("focus falls back to the work area when the old element is gone", () => {
	const input = document.createElement("input");
	const work = document.createElement("main");
	work.tabIndex = -1;
	document.body.append(input, work);
	input.focus();
	const deadline = new Date(Date.now() + 60_000).toISOString();
	const view = render(
		<IdleNotice
			deadline={deadline}
			minutes={1}
			onKeepWorking={() => {}}
			fallbackFocus={{ current: work }}
		/>,
	);
	input.remove();
	view.unmount();
	expect(document.activeElement).toBe(work);
	work.remove();
});

test("focus the student moved elsewhere is left alone", () => {
	const input = document.createElement("input");
	const other = document.createElement("button");
	document.body.append(input, other);
	input.focus();
	const deadline = new Date(Date.now() + 60_000).toISOString();
	const view = render(
		<IdleNotice deadline={deadline} minutes={1} onKeepWorking={() => {}} />,
	);
	other.focus();
	view.unmount();
	expect(document.activeElement).toBe(other);
	input.remove();
	other.remove();
});
