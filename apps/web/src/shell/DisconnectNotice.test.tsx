import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DisconnectNotice, disconnectAnnouncement } from "./DisconnectNotice.js";
import { stopTime } from "./useCountdown.js";

test("counts the minutes left and offers to reconnect now", () => {
	const onReconnect = vi.fn();
	const deadline = new Date(Date.now() + 9 * 60_000 + 30_000).toISOString();
	render(<DisconnectNotice deadline={deadline} onReconnect={onReconnect} />);

	const notice = screen.getByTestId("disconnect-notice");
	expect(notice.textContent).toContain("10 minutes");
	expect(notice.textContent).toContain("Your files are saved");

	fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
	expect(onReconnect).toHaveBeenCalledTimes(1);
});

test("the visible notice is not a live region, since its minutes tick", () => {
	const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
	render(<DisconnectNotice deadline={deadline} onReconnect={() => {}} />);
	const notice = screen.getByTestId("disconnect-notice");
	expect(notice.getAttribute("role")).toBeNull();
	expect(notice.getAttribute("aria-live")).toBeNull();
});

test("the announcement names the stop time, not the minutes left", () => {
	const target = Date.now() + 9 * 60_000;
	const text = disconnectAnnouncement(new Date(target).toISOString());
	expect(text).toBe(
		`You're disconnected. Your workspace will stop at ${stopTime(target)} unless a window reconnects.`,
	);
	expect(text).not.toMatch(/minute/);
});

test("an unreadable deadline announces nothing", () => {
	expect(disconnectAnnouncement("not a date")).toBe("");
});
