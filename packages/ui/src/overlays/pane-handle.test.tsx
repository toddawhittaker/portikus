import { fireEvent, render, screen } from "@testing-library/react";
import { Group, Panel } from "react-resizable-panels";
import { describe, expect, it, vi } from "vitest";
import { PaneHandle } from "./pane-handle";

function Fixture({ onReset }: { onReset?: () => void }) {
	return (
		<Group orientation="horizontal">
			<Panel defaultSize="30%">left</Panel>
			<PaneHandle label="Resize the project list" onReset={onReset} />
			<Panel>right</Panel>
		</Group>
	);
}

describe("PaneHandle", () => {
	it("renders a focusable separator with its label", () => {
		render(<Fixture />);

		const handle = screen.getByRole("separator", { name: "Resize the project list" });
		expect(handle.getAttribute("tabindex")).toBe("0");
		expect(handle.className).toContain("pk-handle");
		expect(handle.getAttribute("data-orientation")).toBe("vertical");
	});

	it("calls onReset on double-click", () => {
		const onReset = vi.fn();
		render(<Fixture onReset={onReset} />);

		fireEvent.doubleClick(screen.getByRole("separator"));
		expect(onReset).toHaveBeenCalledTimes(1);
	});
});
