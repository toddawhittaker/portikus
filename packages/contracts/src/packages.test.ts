import { describe, expect, test } from "vitest";
import {
	AdminPackagesResponse,
	isBaseImageCandidate,
	parseAptList,
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

describe("parseAptList reads the apt hook's list as the image writes it", () => {
	test("the image version comes from the first-line header", () => {
		expect(parseAptList("# portikus-image: 2026.09.99\npython3-venv\ntree\n")).toEqual({
			image: "2026.09.99",
			packages: ["python3-venv", "tree"],
			body: ["python3-venv", "tree", ""],
		});
	});

	test("lines that are not package names are dropped, and repeats kept once", () => {
		expect(
			parseAptList("# portikus-image: 2026.09.9\nhtop\nlibc6:amd64\n$(id)\nhtop\n\n"),
		).toMatchObject({ image: "2026.09.9", packages: ["htop"] });
	});

	test("an unknown version, a missing header or another header reads as null", () => {
		expect(parseAptList("# portikus-image: unknown\ntree\n")).toMatchObject({
			image: null,
			packages: ["tree"],
		});
		expect(parseAptList("tree\n").image).toBeNull();
		expect(parseAptList("# image 2026.09.99\ntree\n").image).toBeNull();
		expect(parseAptList("tree\n# portikus-image: 2026.09.99\n").image).toBeNull();
	});
});
