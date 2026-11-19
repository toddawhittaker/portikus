import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICK_HOVER_LABEL_MAX_CHARS } from "../pick/messages.js";
import { labelFor, PICK_LAYER_NAME, startPickMode, throttle, walk } from "./overlay.js";

let frame: HTMLIFrameElement;
let inner: Document;

beforeEach(() => {
	frame = document.createElement("iframe");
	document.body.append(frame);
	inner = frame.contentDocument as Document;
	inner.body.innerHTML = `<main><h1 id="t">Title</h1><p class="lead">Text</p><a href="#">Link</a></main>`;
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.useRealTimers();
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
		expect(walk(inner.documentElement, "ArrowUp")).toBe(inner.documentElement);
		expect(walk(a, "Tab")).toBe(a);
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

describe("startPickMode", () => {
	it("puts a named, focused layer over the frame", () => {
		const { layer } = start();
		expect(layer.getAttribute("aria-label")).toBe(PICK_LAYER_NAME);
		expect(document.activeElement).toBe(layer);
	});

	it("starts at the app's focused element and walks by keyboard", async () => {
		(inner.querySelector("a") as HTMLElement).focus();
		const { layer, onHover, onPick } = start();
		await vi.waitFor(() => expect(onHover).toHaveBeenLastCalledWith('a "Link"'));
		key(layer, "ArrowLeft");
		await vi.waitFor(() => expect(onHover).toHaveBeenLastCalledWith("p.lead"));
		key(layer, "ArrowUp");
		key(layer, "Enter");
		expect(onPick).toHaveBeenCalledExactlyOnceWith(inner.querySelector("main"));
		expect(document.querySelector(".pick-layer")).toBeNull();
	});

	it("starts at the body when nothing in the app has focus", async () => {
		const { onHover } = start();
		await vi.waitFor(() =>
			expect(onHover).toHaveBeenCalledWith('body "TitleTextLink"'),
		);
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

	it("scrolls the app on wheel", () => {
		const scrollBy = vi.fn();
		(frame.contentWindow as Window).scrollBy = scrollBy;
		const { layer } = start();
		layer.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 40 }));
		expect(scrollBy).toHaveBeenCalledWith(0, 40);
	});
});
