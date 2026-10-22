import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BASE_MIB,
	estimate,
	LANGUAGE_MIB,
	PLATFORM_MIB,
	RESERVE_MIB,
} from "./estimate.js";

const GIB = 1024 ** 3;

describe("estimate", () => {
	it("on 16 GiB with both languages, holds 32 Traditional or 23 Agentic students", () => {
		const result = estimate(16 * GIB, ["python", "typescript"]);
		expect(result.addedMiB).toBe(242);
		expect(result.traditional).toEqual({ perStudentMiB: 402, students: 32 });
		expect(result.agentic).toEqual({ perStudentMiB: 552, students: 23 });
	});

	it("on 8 GiB holds far fewer", () => {
		const result = estimate(8 * GIB, ["python", "typescript"]);
		// (8192 - 1434 - 2048) / 402 and / 552, rounded down.
		expect(result.traditional.students).toBe(11);
		expect(result.agentic.students).toBe(8);
	});

	it("with no language ticked, adds nothing", () => {
		const result = estimate(16 * GIB, []);
		expect(result.addedMiB).toBe(0);
		expect(result.traditional).toEqual({ perStudentMiB: 160, students: 80 });
		expect(result.agentic).toEqual({ perStudentMiB: 310, students: 41 });
	});

	it("with one language, adds only its own memory", () => {
		expect(estimate(16 * GIB, ["typescript"]).addedMiB).toBe(57);
		expect(estimate(16 * GIB, ["python", "python"]).addedMiB).toBe(185);
	});

	it("with the server's memory unknown, gives memory per student and no count", () => {
		const result = estimate(null, ["python"]);
		expect(result.traditional).toEqual({ perStudentMiB: 345, students: null });
		expect(result.agentic).toEqual({ perStudentMiB: 495, students: null });
	});

	it("never counts fewer than no students", () => {
		expect(estimate(2 * GIB, ["python"]).agentic.students).toBe(0);
	});
});

/** The rows of the "Estimate on the Settings page" table in docs/CAPACITY.md, by figure. */
function capacityTable(): Map<string, number> {
	const doc = readFileSync(
		`${import.meta.dirname}/../../../../../docs/CAPACITY.md`,
		"utf8",
	);
	const section = doc.split("### Estimate on the Settings page")[1]?.split("\n## ")[0];
	if (!section) throw new Error("docs/CAPACITY.md has no estimate table");
	const rows = new Map<string, number>();
	for (const line of section.split("\n")) {
		const match = /^\| ([^|]+?) \| (\d+) \|/.exec(line);
		if (match?.[1] && match[2]) rows.set(match[1], Number(match[2]));
	}
	return rows;
}

it("uses the figures docs/CAPACITY.md gives", () => {
	expect(Object.fromEntries(capacityTable())).toEqual({
		"Python, per student": LANGUAGE_MIB.python,
		"TypeScript and JavaScript, per student": LANGUAGE_MIB.typescript,
		"Traditional workspace without code help": BASE_MIB.traditional,
		"Agentic workspace without code help": BASE_MIB.agentic,
		Platform: PLATFORM_MIB,
		"Reserve kept free": RESERVE_MIB,
	});
});
