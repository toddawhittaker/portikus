import { afterEach, expect, test, vi } from "vitest";
import { fromEmptySpace } from "./barDrag.js";

afterEach(() => {
	document.body.replaceChildren();
});

function bar(): HTMLElement {
	const header = document.createElement("header");
	header.innerHTML =
		'<span class="name">app.ts</span><div class="tools"><button type="button"><svg></svg></button><label>Wrap <input type="checkbox"></label></div>';
	document.body.append(header);
	return header;
}

function press(
	listeners: ReturnType<typeof fromEmptySpace>,
	target: Element | null,
	header: Element,
) {
	listeners?.onPointerDown?.({ target, currentTarget: header });
}

/** SPEC.md §9.3: a press on the bar's empty space or its name starts the drag. */
test("a press on the bar, its name or the space between its controls reaches the drag", () => {
	const onPointerDown = vi.fn();
	const header = bar();
	const listeners = fromEmptySpace({ onPointerDown });
	press(listeners, header, header);
	press(listeners, header.querySelector(".name"), header);
	press(listeners, header.querySelector(".tools"), header);
	expect(onPointerDown).toHaveBeenCalledTimes(3);
});

test("a press on a button, inside one, or on a field is left to that control", () => {
	const onPointerDown = vi.fn();
	const header = bar();
	const listeners = fromEmptySpace({ onPointerDown });
	for (const selector of ["button", "svg", "label", "input"]) {
		press(listeners, header.querySelector(selector), header);
	}
	expect(onPointerDown).not.toHaveBeenCalled();
});

/** A menu the bar opens is portalled to the body, yet React bubbles its events to the bar. */
test("a press outside the bar's own DOM is left alone", () => {
	const onPointerDown = vi.fn();
	const header = bar();
	const menuItem = document.createElement("div");
	menuItem.setAttribute("role", "menuitem");
	document.body.append(menuItem);
	press(fromEmptySpace({ onPointerDown }), menuItem, header);
	expect(onPointerDown).not.toHaveBeenCalled();
});

test("no listeners from dnd-kit means none on the bar", () => {
	expect(fromEmptySpace(undefined)).toBeUndefined();
});
