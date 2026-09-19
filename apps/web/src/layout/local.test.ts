import { afterEach, expect, test } from "vitest";
import { clearLocalLayouts, readLocalLayout, writeLocalLayout } from "./local";

afterEach(() => {
	localStorage.clear();
});

test("signing out clears every project's browser-local layout", () => {
	writeLocalLayout("project-a", { activeTabId: "tab-1", viewStates: {} });
	writeLocalLayout("project-b", { activeTabId: "tab-2", viewStates: {} });
	localStorage.setItem("portikus.theme", "dark");

	clearLocalLayouts();

	expect(readLocalLayout("project-a")).toBeNull();
	expect(readLocalLayout("project-b")).toBeNull();
	// Only the layout keys go; other settings are not this function's business.
	expect(localStorage.getItem("portikus.theme")).toBe("dark");
});
