import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { showMonitor, useRightPaneStore } from "./rightPane.js";

test("showMonitor selects Monitor and sorts that column largest first", () => {
	const { result } = renderHook(() => useRightPaneStore());
	expect(result.current.pane).toBe("files");
	expect(result.current.monitorSort).toEqual({
		column: "cpu",
		direction: "descending",
	});

	act(() => showMonitor(result.current, "memory"));
	expect(result.current.pane).toBe("monitor");
	// Monitor moves focus to itself when a button elsewhere opened it.
	expect(result.current.monitorFocus).toBe(true);
	expect(result.current.monitorSort).toEqual({
		column: "memory",
		direction: "descending",
	});

	act(() => result.current.setMonitorSort({ column: "cpu", direction: "ascending" }));
	act(() => showMonitor(result.current, "cpu"));
	expect(result.current.monitorSort).toEqual({
		column: "cpu",
		direction: "descending",
	});
});
