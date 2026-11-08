import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { inertOutside, ShellDrawer, usePhoneLayout, wrapTab } from "./ShellDrawer.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function stubWidth(phone: boolean) {
	const listeners = new Set<() => void>();
	const query = {
		matches: phone,
		addEventListener: (_: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_: string, listener: () => void) =>
			listeners.delete(listener),
	};
	vi.stubGlobal("matchMedia", () => query);
	return (next: boolean) => {
		query.matches = next;
		for (const listener of listeners) listener();
	};
}

function Shell({ phone }: { phone: boolean }) {
	const [open, setOpen] = useState(false);
	const opener = useRef<HTMLButtonElement>(null);
	return (
		<div className="pk-root">
			<header>
				<button type="button" ref={opener} onClick={() => setOpen(true)}>
					Projects
				</button>
			</header>
			<div>
				<ShellDrawer
					id="projects-drawer"
					side="left"
					label="Projects"
					phone={phone}
					open={open}
					onClose={() => setOpen(false)}
					opener={opener}
				>
					<nav aria-label="Project list">
						<a href="/elsewhere">A project</a>
						<a href="/help" target="_blank" rel="noopener">
							Help
						</a>
						<button type="button">New project</button>
					</nav>
				</ShellDrawer>
				<main>Work</main>
			</div>
		</div>
	);
}

function Probe() {
	return <p>{usePhoneLayout() ? "phone" : "wide"}</p>;
}

test("usePhoneLayout follows the 56rem media query", () => {
	const setPhone = stubWidth(false);
	render(<Probe />);
	expect(screen.getByText("wide")).toBeDefined();
	act(() => setPhone(true));
	expect(screen.getByText("phone")).toBeDefined();
});

test("at desktop widths the drawer is neither a dialog nor has a close button", () => {
	render(<Shell phone={false} />);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.queryByRole("button", { name: "Close projects" })).toBeNull();
	expect(screen.getByRole("navigation", { name: "Project list" })).toBeDefined();
});

test("an open phone drawer is a named modal dialog with focus inside and the rest inert", () => {
	render(<Shell phone={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Projects" }));
	const dialog = screen.getByRole("dialog", { name: "Projects" });
	expect(dialog.getAttribute("aria-modal")).toBe("true");
	expect(document.activeElement).toBe(dialog);
	expect(screen.getByText("Work").hasAttribute("inert")).toBe(true);
	expect(document.querySelector("header")?.hasAttribute("inert")).toBe(true);

	fireEvent.keyDown(dialog, { key: "Escape" });
	expect(screen.getByText("Work").hasAttribute("inert")).toBe(false);
	expect(document.querySelector("header")?.hasAttribute("inert")).toBe(false);
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Projects" }));
});

test("the close button, a scrim tap and a followed link close it; a new-tab link and Escape from a prevented key do not", () => {
	render(<Shell phone={true} />);
	const opener = screen.getByRole("button", { name: "Projects" });
	const dialog = () => document.getElementById("projects-drawer") as HTMLElement;
	const isOpen = () => dialog().closest("[data-open]") !== null;

	fireEvent.click(opener);
	fireEvent.click(screen.getByRole("button", { name: "Close projects" }));
	expect(isOpen()).toBe(false);

	fireEvent.click(opener);
	fireEvent.click(document.querySelector(".pk-drawer-scrim") as HTMLElement);
	expect(isOpen()).toBe(false);

	fireEvent.click(opener);
	fireEvent.click(screen.getByText("Help"));
	expect(isOpen()).toBe(true);
	const prevented = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	prevented.preventDefault();
	screen.getByText("New project").dispatchEvent(prevented);
	expect(isOpen()).toBe(true);
	fireEvent.click(screen.getByText("A project"));
	expect(isOpen()).toBe(false);
});

test("inertOutside stops at the shell root and leaves already inert elements as they were", () => {
	document.body.innerHTML = `
		<aside id="outside"></aside>
		<div class="pk-root">
			<header id="head"></header>
			<section id="was" inert></section>
			<div><div id="layer"></div><main id="work"></main></div>
		</div>`;
	const get = (id: string) => document.getElementById(id) as HTMLElement;
	const undo = inertOutside(get("layer"));
	expect(get("head").hasAttribute("inert")).toBe(true);
	expect(get("work").hasAttribute("inert")).toBe(true);
	expect(get("outside").hasAttribute("inert")).toBe(false);
	undo();
	expect(get("head").hasAttribute("inert")).toBe(false);
	expect(get("was").hasAttribute("inert")).toBe(true);
	document.body.innerHTML = "";
});

test("wrapTab sends Tab from the last stop to the first and Shift+Tab back", () => {
	document.body.innerHTML = `<div id="sheet" tabindex="-1"><button id="a">A</button><button id="b">B</button></div>`;
	const sheet = document.getElementById("sheet") as HTMLElement;
	const a = document.getElementById("a") as HTMLElement;
	const b = document.getElementById("b") as HTMLElement;
	// jsdom lays nothing out, so every element reports a box.
	for (const el of [a, b]) el.getClientRects = () => [{}] as unknown as DOMRectList;

	b.focus();
	const forward = { shiftKey: false, preventDefault: vi.fn() };
	wrapTab(sheet, forward);
	expect(document.activeElement).toBe(a);
	expect(forward.preventDefault).toHaveBeenCalled();

	const back = { shiftKey: true, preventDefault: vi.fn() };
	wrapTab(sheet, back);
	expect(document.activeElement).toBe(b);

	sheet.focus();
	wrapTab(sheet, { shiftKey: true, preventDefault: vi.fn() });
	expect(document.activeElement).toBe(b);

	// In the middle, Tab is left to the browser.
	a.focus();
	const middle = { shiftKey: false, preventDefault: vi.fn() };
	wrapTab(sheet, middle);
	expect(middle.preventDefault).not.toHaveBeenCalled();
	document.body.innerHTML = "";
});
