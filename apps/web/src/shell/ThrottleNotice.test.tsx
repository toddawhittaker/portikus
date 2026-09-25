import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ThrottleNotice } from "./ThrottleNotice.js";

test("says why the workspace is slow, with the numbers from the row", () => {
	const onDismiss = vi.fn();
	render(
		<ThrottleNotice
			throttle={{
				at: "2026-09-25T12:00:00.000Z",
				thresholdPercent: 70,
				windowMinutes: 45,
				sharePercent: 50,
			}}
			onDismiss={onDismiss}
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
});
