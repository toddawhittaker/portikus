import { afterEach, expect, test } from "vitest";
import { currentSection } from "./SectionIndex.js";
import { SECTIONS } from "./sections.js";

afterEach(() => {
	document.body.innerHTML = "";
});

/** A section card whose top sits at `top` pixels down the window. */
function card(id: string, top: number) {
	const element = document.createElement("section");
	element.dataset.testid = id;
	element.getBoundingClientRect = () => ({ top }) as DOMRect;
	document.body.append(element);
}

test("the current section is the last whose top has passed the line", () => {
	card(SECTIONS.stop.id, -900);
	card(SECTIONS.guard.id, -200);
	card(SECTIONS.tools.id, 300);
	card(SECTIONS.aup.id, 900);
	expect(currentSection(400)).toBe(SECTIONS.tools.id);
	expect(currentSection(100)).toBe(SECTIONS.guard.id);
});

test("sections that have not rendered yet are skipped, and none passed means none current", () => {
	card(SECTIONS.guard.id, 600);
	expect(currentSection(400)).toBeNull();
	card(SECTIONS.stop.id, 100);
	expect(currentSection(400)).toBe(SECTIONS.stop.id);
});
