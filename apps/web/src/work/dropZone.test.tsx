import { expect, test } from "vitest";
import { dropZone, insertionIndex } from "./dropZone";

const pane = { left: 0, top: 0, width: 200, height: 100 };

test("the nearest half-edge wins", () => {
	expect(dropZone(pane, 5, 50)).toBe("left");
	expect(dropZone(pane, 195, 50)).toBe("right");
	expect(dropZone(pane, 100, 3)).toBe("top");
	expect(dropZone(pane, 100, 97)).toBe("bottom");
});

test("the middle third both ways is the swap zone", () => {
	expect(dropZone(pane, 100, 50)).toBe("center");
	// In the middle across but high up: still the top edge.
	expect(dropZone(pane, 100, 20)).toBe("top");
	// In the middle down but far left: still the left edge.
	expect(dropZone(pane, 20, 50)).toBe("left");
});

test("the zone is measured from the pane, not the page", () => {
	const offset = { left: 400, top: 300, width: 200, height: 100 };
	expect(dropZone(offset, 405, 350)).toBe("left");
	expect(dropZone(offset, 595, 350)).toBe("right");
	expect(dropZone(offset, 500, 350)).toBe("center");
});

test("a pane with no size cannot pick an edge", () => {
	expect(dropZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe("center");
});

test("the insertion index counts the tab midpoints the pointer has passed", () => {
	const tabs = [
		{ left: 0, width: 100 },
		{ left: 100, width: 100 },
		{ left: 200, width: 100 },
	];
	expect(insertionIndex(tabs, 10)).toBe(0);
	expect(insertionIndex(tabs, 60)).toBe(1);
	expect(insertionIndex(tabs, 160)).toBe(2);
	expect(insertionIndex(tabs, 900)).toBe(3);
	expect(insertionIndex([], 50)).toBe(0);
});
