import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DisconnectNotice } from "./DisconnectNotice.js";

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
