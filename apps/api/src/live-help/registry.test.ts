import { CloseCode } from "@portikus/contracts";
import { describe, expect, test, vi } from "vitest";
import { createLiveHelpRegistry } from "./registry.js";

describe("the live help socket registry", () => {
	test("an end closes every socket of that session and no other", () => {
		const registry = createLiveHelpRegistry();
		const first = vi.fn();
		const second = vi.fn();
		const other = vi.fn();
		registry.add("s1", first);
		registry.add("s1", second);
		registry.add("s2", other);
		registry.end("s1");
		expect(first).toHaveBeenCalledWith(CloseCode.LIVE_HELP_ENDED, "live help ended");
		expect(second).toHaveBeenCalledWith(CloseCode.LIVE_HELP_ENDED, "live help ended");
		expect(other).not.toHaveBeenCalled();
		expect(registry.open("s1")).toBe(0);
		expect(registry.open("s2")).toBe(1);
	});

	test("a mode change closes with its own code", () => {
		const registry = createLiveHelpRegistry();
		const end = vi.fn();
		registry.add("s1", end);
		registry.modeChanged("s1");
		expect(end).toHaveBeenCalledWith(
			CloseCode.LIVE_HELP_MODE_CHANGED,
			"live help mode changed",
		);
	});

	test("a socket that went away is not closed again", () => {
		const registry = createLiveHelpRegistry();
		const end = vi.fn();
		const forget = registry.add("s1", end);
		forget();
		expect(registry.open("s1")).toBe(0);
		registry.end("s1");
		expect(end).not.toHaveBeenCalled();
	});
});
