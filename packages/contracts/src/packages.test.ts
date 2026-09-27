import { describe, expect, test } from "vitest";
import {
	AdminPackagesResponse,
	isBaseImageCandidate,
	ReinstallNote,
	reinstallCommand,
} from "./packages.js";

describe("the base-image candidate rule (ADR 0042)", () => {
	test("needs at least two workspaces", () => {
		expect(isBaseImageCandidate(1, 1)).toBe(false);
		expect(isBaseImageCandidate(1, 3)).toBe(false);
		expect(isBaseImageCandidate(2, 2)).toBe(true);
	});

	test("needs at least a third of those surveyed", () => {
		expect(isBaseImageCandidate(3, 9)).toBe(true);
		expect(isBaseImageCandidate(2, 7)).toBe(false);
		expect(isBaseImageCandidate(6, 9)).toBe(true);
	});

	test("nothing surveyed is never a candidate", () => {
		expect(isBaseImageCandidate(2, 0)).toBe(false);
	});
});

describe("the reinstall command", () => {
	test("lists the packages after sudo apt install", () => {
		expect(reinstallCommand(["python3-venv", "g++"])).toBe(
			"sudo apt install python3-venv g++",
		);
	});

	test("never puts a name that is not a package name on the line", () => {
		expect(reinstallCommand(["htop", "x; reboot", "$(id)", "Bad"])).toBe(
			"sudo apt install htop",
		);
	});
});

describe("the package contracts", () => {
	test("the admin response carries counts only", () => {
		const parsed = AdminPackagesResponse.parse({
			day: "2026-09-27",
			surveyed: 9,
			packages: [
				{
					package: "python3-venv",
					workspaces: 6,
					firstSeen: "2026-09-20",
					lastSeen: "2026-09-27",
					candidate: true,
					workspaceId: "leaked",
				},
			],
		});
		expect(Object.keys(parsed.packages[0] ?? {}).sort()).toEqual([
			"candidate",
			"firstSeen",
			"lastSeen",
			"package",
			"workspaces",
		]);
	});

	test("a note refuses a name that is not a package name", () => {
		expect(ReinstallNote.safeParse({ packages: ["ok-pkg"] }).success).toBe(true);
		expect(ReinstallNote.safeParse({ packages: ["x y"] }).success).toBe(false);
	});
});
