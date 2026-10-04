import { afterEach, expect, test, vi } from "vitest";
import { currentPlatform, tabFocusKey } from "./platform.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a Mac user agent is a Mac, as Monaco also decides", () => {
	vi.stubGlobal("navigator", {
		platform: "",
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
	});
	expect(currentPlatform()).toBe("mac");
	expect(tabFocusKey()).toBe("Ctrl+Shift+M");
});

test("anywhere else the tab-focus key is Ctrl+M", () => {
	vi.stubGlobal("navigator", {
		platform: "Linux x86_64",
		userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
	});
	expect(currentPlatform()).toBe("other");
	expect(tabFocusKey()).toBe("Ctrl+M");
	expect(tabFocusKey("mac")).toBe("Ctrl+Shift+M");
});
