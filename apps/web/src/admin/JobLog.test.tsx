import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { JobLog } from "./JobLog.js";

test("names the log region by its heading and takes focus so it scrolls by keyboard", () => {
	render(<JobLog idPrefix="cert" log={["one", "<b>two</b>"]} />);
	const region = screen.getByRole("region", { name: "Log" });
	expect(region.getAttribute("data-testid")).toBe("cert-job-log");
	expect(region.tabIndex).toBe(0);
	// Plain text: a log line is never rendered as HTML.
	expect(region.textContent).toBe("one\n<b>two</b>");
	expect(region.querySelector("b")).toBeNull();
});

test("says when there is no output yet", () => {
	render(<JobLog idPrefix="image" log={[]} />);
	expect(screen.getByTestId("image-job-log").textContent).toBe("No output yet.");
});
