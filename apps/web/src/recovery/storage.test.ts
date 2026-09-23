import { expect, test } from "vitest";
import { storageLevel, storageWarning } from "./storage.js";

const GB = 1024 ** 3;
const figure = (percent: number) => ({ usedBytes: percent * GB, totalBytes: 100 * GB });
const none = { home: null, docker: null, recovery: null };

test("79% is fine, 80% warns, 95% is critical, null is unknown", () => {
	expect(storageLevel(figure(79))).toBe("ok");
	expect(storageLevel(figure(80))).toBe("warning");
	expect(storageLevel(figure(94))).toBe("warning");
	expect(storageLevel(figure(95))).toBe("critical");
	expect(storageLevel(null)).toBeNull();
	expect(storageLevel({ usedBytes: 0, totalBytes: 0 })).toBeNull();
});

test("no warning below 80% or with no figures", () => {
	expect(storageWarning(undefined)).toBeNull();
	expect(storageWarning(none)).toBeNull();
	expect(storageWarning({ ...none, docker: figure(79) })).toBeNull();
});

test("80% names the class", () => {
	expect(storageWarning({ ...none, docker: figure(80) })?.text).toBe(
		"Docker storage is 80% full",
	);
	expect(storageWarning({ ...none, recovery: figure(85) })?.text).toBe(
		"Recovery storage is 85% full",
	);
	expect(storageWarning({ ...none, home: figure(81) })?.text).toBe(
		"Projects & home storage is 81% full",
	);
});

test("95% names the class and a next step for each", () => {
	const docker = storageWarning({ ...none, docker: figure(96) });
	expect(docker?.level).toBe("critical");
	expect(docker?.text).toBe("Docker storage is nearly full");
	expect(docker?.detail).toContain("Reset Docker");
	expect(storageWarning({ ...none, recovery: figure(95) })?.detail).toContain(
		"removed automatically",
	);
	expect(storageWarning({ ...none, home: figure(99) })?.detail).toContain(
		"Delete files",
	);
});

test("the fullest class wins", () => {
	const warning = storageWarning({
		home: figure(85),
		docker: figure(97),
		recovery: null,
	});
	expect(warning?.storageClass).toBe("docker");
});
