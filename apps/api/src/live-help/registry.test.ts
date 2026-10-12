import { CloseCode } from "@portikus/contracts";
import { describe, expect, test, vi } from "vitest";
import { createLiveHelpRegistry } from "./registry.js";

describe("the live help socket registry", () => {
	test("an end closes every socket of that session and no other", () => {
		const registry = createLiveHelpRegistry();
		const first = vi.fn();
		const second = vi.fn();
		const other = vi.fn();
		registry.add("s1", "t1", first);
		registry.add("s1", "t2", second);
		registry.add("s2", "t1", other);
		registry.end("s1");
		expect(first).toHaveBeenCalledWith(CloseCode.LIVE_HELP_ENDED, "live help ended");
		expect(second).toHaveBeenCalledWith(CloseCode.LIVE_HELP_ENDED, "live help ended");
		expect(other).not.toHaveBeenCalled();
		// An ended session holds nothing, so a second end closes nothing again.
		registry.end("s1");
		expect(first).toHaveBeenCalledTimes(1);
		registry.end("s2");
		expect(other).toHaveBeenCalledTimes(1);
	});

	test("a mode change closes with its own code", () => {
		const registry = createLiveHelpRegistry();
		const end = vi.fn();
		registry.add("s1", "t1", end);
		registry.modeChanged("s1");
		expect(end).toHaveBeenCalledWith(
			CloseCode.LIVE_HELP_MODE_CHANGED,
			"live help mode changed",
		);
	});

	test("a socket that went away is not closed again", () => {
		const registry = createLiveHelpRegistry();
		const end = vi.fn();
		const forget = registry.add("s1", "t1", end);
		forget?.();
		registry.end("s1");
		expect(end).not.toHaveBeenCalled();
	});

	test("holds one socket per terminal of a session until it goes away", () => {
		const registry = createLiveHelpRegistry();
		const first = vi.fn();
		const forget = registry.add("s1", "t1", first);
		expect(forget).not.toBeNull();
		expect(registry.has("s1", "t1")).toBe(true);
		expect(registry.add("s1", "t1", vi.fn())).toBeNull();
		expect(registry.has("s1", "t2")).toBe(false);
		forget?.();
		expect(registry.has("s1", "t1")).toBe(false);
		const again = vi.fn();
		expect(registry.add("s1", "t1", again)).not.toBeNull();
		registry.end("s1");
		expect(again).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
	});
});
