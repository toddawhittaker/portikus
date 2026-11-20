import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICK_HOVER_LABEL_MAX_CHARS } from "../pick/messages.js";
import {
	labelFor,
	PICK_LAYER_NAME,
	settle,
	startPickMode,
	throttle,
	walk,
} from "./overlay.js";

let frame: HTMLIFrameElement;
let inner: Document;

beforeEach(() => {
	frame = document.createElement("iframe");
	document.body.append(frame);
	inner = frame.contentDocument as Document;
	inner.body.innerHTML = `<main><h1 id="t">Title</h1><p class="lead">Text</p><a href="#">Link</a></main>`;
	// jsdom lays nothing out; here every element has a box unless marked.
	const view = frame.contentWindow as Window & typeof globalThis;
	vi.spyOn(view.Element.prototype, "getClientRects").mockImplementation(function (
		this: Element,
	) {
		return (this.hasAttribute("data-undrawn") ? [] : [{}]) as unknown as DOMRectList;
	});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function start(overrides: Partial<Parameters<typeof startPickMode>[0]> = {}) {
	const calls = {
		onHover: vi.fn(),
		onPick: vi.fn(),
		onCancel: vi.fn(),
	};
	const leave = startPickMode({ frame, hoverIntervalMs: 0, ...calls, ...overrides });
	const layer = document.querySelector(".pick-layer") as HTMLElement;
	return { ...calls, leave, layer };
}

const key = (target: EventTarget, name: string) =>
	target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

describe("walk", () => {
	it("moves to the parent, first child and siblings", () => {
		const main = inner.querySelector("main") as Element;
		const p = inner.querySelector("p") as Element;
		expect(walk(p, "ArrowUp")).toBe(main);
		expect(walk(main, "ArrowDown")).toBe(inner.querySelector("h1"));
		expect(walk(p, "ArrowLeft")).toBe(inner.querySelector("h1"));
		expect(walk(p, "ArrowRight")).toBe(inner.querySelector("a"));
	});

	it("stays put where there is nowhere to go", () => {
		const a = inner.querySelector("a") as Element;
		expect(walk(a, "ArrowRight")).toBe(a);
		expect(walk(a, "ArrowDown")).toBe(a);
		expect(walk(a, "Tab")).toBe(a);
	});

	it("stops going up at the body", () => {
		expect(walk(inner.querySelector("main") as Element, "ArrowUp")).toBe(inner.body);
		expect(walk(inner.body, "ArrowUp")).toBe(inner.body);
	});

	it("skips elements with no box and elements never drawn", () => {
		inner.body.innerHTML = `<main><script></script><p data-undrawn></p><h1>One</h1><style></style><template></template><p data-undrawn></p><h2>Two</h2><script></script></main>`;
		const main = inner.querySelector("main") as Element;
		const h1 = inner.querySelector("h1") as Element;
		const h2 = inner.querySelector("h2") as Element;
		expect(walk(main, "ArrowDown")).toBe(h1);
		expect(walk(h1, "ArrowRight")).toBe(h2);
		expect(walk(h2, "ArrowLeft")).toBe(h1);
		expect(walk(h1, "ArrowLeft")).toBe(h1);
		expect(walk(h2, "ArrowRight")).toBe(h2);
		inner.body.innerHTML = `<div><script></script></div>`;
		const div = inner.querySelector("div") as Element;
		expect(walk(div, "ArrowDown")).toBe(div);
	});
});

describe("labelFor", () => {
	it("prefers id, then first class, then a little text", () => {
		expect(labelFor(inner.querySelector("h1") as Element)).toBe("h1#t");
		expect(labelFor(inner.querySelector("p") as Element)).toBe("p.lead");
		expect(labelFor(inner.querySelector("a") as Element)).toBe('a "Link"');
		inner.body.innerHTML = "<div></div>";
		expect(labelFor(inner.querySelector("div") as Element)).toBe("div");
	});

	it("stays within the label limit", () => {
		const el = inner.createElement("div");
		el.id = "x".repeat(500);
		expect(labelFor(el).length).toBe(PICK_HOVER_LABEL_MAX_CHARS);
	});
});

describe("throttle", () => {
	it("sends at most once per interval, with the latest value", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const t = throttle(send, 100);
		t.push("a");
		t.push("b");
		vi.advanceTimersByTime(0);
		expect(send).toHaveBeenCalledExactlyOnceWith("b");
		t.push("c");
		t.push("d");
		vi.advanceTimersByTime(50);
		expect(send).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(50);
		expect(send).toHaveBeenLastCalledWith("d");
		t.push("e");
		t.cancel();
		vi.advanceTimersByTime(200);
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("settle", () => {
	it("sends only the last value, once the values stop for the rest time", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const t = settle(send, 400);
		t.push("a");
		vi.advanceTimersByTime(300);
		t.push("b");
		vi.advanceTimersByTime(300);
		expect(send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(send).toHaveBeenCalledExactlyOnceWith("b");
		t.push("c");
		t.cancel();
		vi.advanceTimersByTime(1000);
		expect(send).toHaveBeenCalledOnce();
	});
});

describe("startPickMode", () => {
	it("puts a named, focused layer over the frame, before it in tab order", () => {
		const { layer } = start();
		expect(layer.getAttribute("aria-label")).toBe(PICK_LAYER_NAME);
		expect(document.activeElement).toBe(layer);
		expect(
			layer.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("does not read the start element, so the instructions are heard first", () => {
		vi.useFakeTimers();
		(inner.querySelector("a") as HTMLElement).focus();
		const { onHover } = start();
		vi.advanceTimersByTime(2000);
		expect(onHover).not.toHaveBeenCalled();
	});

	it("reads the pointer's element only once the pointer rests", () => {
		vi.useFakeTimers();
		const h1 = inner.querySelector("h1") as Element;
		const p = inner.querySelector("p") as Element;
		let under = h1;
		inner.elementFromPoint = vi.fn(() => under);
		const { layer, onHover } = start({ hoverRestMs: 450 });
		layer.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
		vi.advanceTimersByTime(300);
		under = p;
		layer.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 9 }));
		vi.advanceTimersByTime(300);
		expect(onHover).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(onHover).toHaveBeenCalledExactlyOnceWith("p.lead");
	});

	it("starts at the app's focused element and walks by keyboard", async () => {
		(inner.querySelector("a") as HTMLElement).focus();
		const { layer, onHover, onPick } = start();
		key(layer, "ArrowLeft");
		await vi.waitFor(() => expect(onHover).toHaveBeenLastCalledWith("p.lead"));
		key(layer, "ArrowUp");
		key(layer, "Enter");
		expect(onPick).toHaveBeenCalledExactlyOnceWith(inner.querySelector("main"));
		expect(document.querySelector(".pick-layer")).toBeNull();
	});

	it("starts at the body when nothing in the app has focus", () => {
		const { layer, onPick } = start();
		key(layer, "Enter");
		expect(onPick).toHaveBeenCalledExactlyOnceWith(inner.body);
	});

	it("picks the element under the pointer on click, and only once", () => {
		const h1 = inner.querySelector("h1") as Element;
		inner.elementFromPoint = vi.fn(() => h1);
		const { layer, onPick } = start();
		layer.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
		layer.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5 }));
		layer.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5 }));
		key(layer, "Enter");
		expect(onPick).toHaveBeenCalledExactlyOnceWith(h1);
		expect(inner.elementFromPoint).toHaveBeenCalledWith(5, 5);
	});

	it("cancels on Escape in the wrapper", () => {
		const { layer, onCancel, onPick } = start();
		key(layer, "Escape");
		key(layer, "Escape");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onPick).not.toHaveBeenCalled();
	});

	it("cancels on Escape in the app's document", () => {
		const { onCancel } = start();
		key(inner.body, "Escape");
		expect(onCancel).toHaveBeenCalledOnce();
		key(inner.body, "Escape");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("leaves without calling back when stopped", () => {
		const { leave, layer, onCancel, onPick } = start();
		leave();
		key(layer, "Escape");
		key(inner.body, "Escape");
		expect(onCancel).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
		expect(document.querySelector(".pick-box")).toBeNull();
		leave();
	});

	it("scrolls the nearest scrollable ancestor of the element under the pointer", () => {
		inner.body.innerHTML = `<div id="list" style="overflow-y: auto"><p id="row">Row</p></div>`;
		const list = inner.getElementById("list") as HTMLElement;
		Object.defineProperty(list, "scrollHeight", { value: 500 });
		Object.defineProperty(list, "clientHeight", { value: 100 });
		const listScroll = vi.fn();
		list.scrollBy = listScroll;
		const pageScroll = vi.fn();
		(frame.contentWindow as Window).scrollBy = pageScroll;
		inner.elementFromPoint = vi.fn(() => inner.getElementById("row"));
		const { layer } = start();
		layer.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 40 }));
		expect(listScroll).toHaveBeenCalledWith(0, 40);
		expect(pageScroll).not.toHaveBeenCalled();
	});

	it("starts at the element it is given, or the body when that one is gone", () => {
		const p = inner.querySelector("p") as Element;
		const first = start({ start: p });
		key(first.layer, "Enter");
		expect(first.onPick).toHaveBeenCalledExactlyOnceWith(p);
		p.remove();
		const second = start({ start: p });
		key(second.layer, "Enter");
		expect(second.onPick).toHaveBeenCalledExactlyOnceWith(inner.body);
	});

	it("scrolls the app on wheel when nothing under the pointer scrolls", () => {
		inner.elementFromPoint = vi.fn(() => inner.querySelector("p"));
		const scrollBy = vi.fn();
		(frame.contentWindow as Window).scrollBy = scrollBy;
		const { layer } = start();
		layer.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 40 }));
		expect(scrollBy).toHaveBeenCalledWith(0, 40);
	});
});
