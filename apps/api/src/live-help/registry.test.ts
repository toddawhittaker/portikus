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
		forget();
		registry.end("s1");
		expect(end).not.toHaveBeenCalled();
	});

	test("the newest socket on a terminal closes the older one before it is held", () => {
		const registry = createLiveHelpRegistry();
		const order: string[] = [];
		const first = vi.fn(() => order.push("first closed"));
		const forgetFirst = registry.add("s1", "t1", first);
		expect(registry.has("s1", "t1")).toBe(true);
		const second = vi.fn();
		const forgetSecond = registry.add("s1", "t1", second);
		order.push("second held");
		expect(first).toHaveBeenCalledWith(
			CloseCode.LIVE_HELP_REPLACED,
			"opened in another tab",
		);
		expect(order).toEqual(["first closed", "second held"]);
		// The older socket going away later must not forget the newer one.
		forgetFirst();
		expect(registry.has("s1", "t1")).toBe(true);
		expect(registry.has("s1", "t2")).toBe(false);
		registry.end("s1");
		expect(second).toHaveBeenCalledWith(CloseCode.LIVE_HELP_ENDED, "live help ended");
		expect(first).toHaveBeenCalledTimes(1);
		forgetSecond();
		expect(registry.has("s1", "t1")).toBe(false);
	});
});
