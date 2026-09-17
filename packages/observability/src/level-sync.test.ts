import { expect, test } from "vitest";
import { applyLevel } from "./level-sync.js";
import { collectingLogger, lineAt } from "./testing.js";

test("an override wins, and clearing it reverts to the environment level", () => {
	const { logger, lines } = collectingLogger("info");

	expect(applyLevel(logger, "info", "debug")).toBe("debug");
	expect(logger.level).toBe("debug");
	expect(lines).toHaveLength(1);
	expect(lineAt(lines, 0).msg).toBe("log level changed");
	expect(lineAt(lines, 0).from).toBe("info");
	expect(lineAt(lines, 0).to).toBe("debug");
	expect(lineAt(lines, 0).source).toBe("settings");

	expect(applyLevel(logger, "info", null)).toBe("info");
	expect(logger.level).toBe("info");
	expect(lines).toHaveLength(2);
	expect(lineAt(lines, 1).source).toBe("environment");
});

test("no change logs nothing, however often it is called", () => {
	const { logger, lines } = collectingLogger("info");
	applyLevel(logger, "info", null);
	applyLevel(logger, "info", "info");
	applyLevel(logger, "info", null);
	expect(lines).toHaveLength(0);
	expect(logger.level).toBe("info");
});

test("a change to a quieter level is still announced", () => {
	const { logger, lines } = collectingLogger("info");
	expect(applyLevel(logger, "info", "error")).toBe("error");
	expect(logger.level).toBe("error");
	expect(lines).toHaveLength(1);
	expect(lineAt(lines, 0).msg).toBe("log level changed");
	expect(lineAt(lines, 0).to).toBe("error");
});
