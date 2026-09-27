import { expect, test } from "vitest";
import { STORAGE_POLL_MS, USAGE_POLL_MS, usagePollInterval } from "./usage.js";

test("the status bar asks every 2 s until its first sample, then every 30 s", () => {
	expect(usagePollInterval(false, STORAGE_POLL_MS)).toBe(2000);
	expect(usagePollInterval(true, STORAGE_POLL_MS)).toBe(30_000);
	// A faster poll is never slowed down.
	expect(usagePollInterval(false, USAGE_POLL_MS)).toBe(1000);
});

test("after a failure in the error state, the storage poll slows to 30 seconds", () => {
	expect(usagePollInterval(false, STORAGE_POLL_MS, true)).toBe(30_000);
});
