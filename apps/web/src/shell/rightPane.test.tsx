import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { showMonitor, useRightPaneStore } from "./rightPane.js";

test("showMonitor selects Monitor and sorts that column largest first", () => {
	const { result } = renderHook(() => useRightPaneStore());
	expect(result.current.pane).toBe("files");
	expect(result.current.monitorSort).toEqual({ column: "cpu", direction: "desc" });

	act(() => showMonitor(result.current, "memory"));
	expect(result.current.pane).toBe("monitor");
	expect(result.current.monitorSort).toEqual({ column: "memory", direction: "desc" });

	act(() => result.current.setMonitorSort({ column: "cpu", direction: "asc" }));
	act(() => showMonitor(result.current, "cpu"));
	expect(result.current.monitorSort).toEqual({ column: "cpu", direction: "desc" });
});
