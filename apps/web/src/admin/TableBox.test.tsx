import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TableBox } from "./TableBox.js";

let notify: (() => void) | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	notify = null;
	// Back to the widths jsdom inherits from Element.
	Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
	Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

/** A ResizeObserver the test can fire, and a box whose widths it chooses. */
function widths(scroll: number, client: number) {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				notify = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get: () => scroll,
	});
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => client,
	});
}

test("a table that fits adds no tab stop and no region", () => {
	widths(400, 600);
	render(
		<TableBox label="Certificates in use">
			<table />
		</TableBox>,
	);
	expect(screen.queryByRole("region")).toBeNull();
	expect(document.querySelector(".pk-table-wrap")?.hasAttribute("tabindex")).toBe(
		false,
	);
});

test("a table wider than its box makes the box a named region the keyboard can reach", () => {
	widths(800, 600);
	render(
		<TableBox label="Certificates in use">
			<table />
		</TableBox>,
	);
	const region = screen.getByRole("region", { name: "Certificates in use" });
	expect(region.getAttribute("tabindex")).toBe("0");
	// Wide enough again after a resize, it steps back out of the tab order.
	widths(400, 600);
	act(() => notify?.());
	expect(screen.queryByRole("region")).toBeNull();
});
