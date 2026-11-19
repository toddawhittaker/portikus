import { afterEach, describe, expect, it, vi } from "vitest";
import { PICK_PNG_MAX_BYTES, parseWrapperMessage } from "../pick/messages.js";
import { PREVIEW_FRAME_ALLOW } from "../previewAllow.js";
import { STANDALONE_MESSAGE, startWrapper } from "./wrapper.js";

afterEach(() => {
	document.body.innerHTML = "";
});

/** A wrapper running in a frame of the test page, which plays the Portikus page. */
function mount(draw = vi.fn(async () => undefined as ArrayBuffer | undefined)) {
	const outer = document.createElement("iframe");
	document.body.append(outer);
	const win = outer.contentWindow as Window;
	const posted: unknown[] = [];
	vi.spyOn(win.parent, "postMessage").mockImplementation((message: unknown) => {
		posted.push(message);
	});
	startWrapper(win, { draw, hoverIntervalMs: 0 });
	const app = win.document.querySelector("iframe.app") as HTMLIFrameElement;
	// jsdom does not load "/", so the app's document is filled by hand.
	const appDoc = app.contentDocument as Document;
	appDoc.open();
	appDoc.write("<!doctype html><html><body><p>App</p></body></html>");
	appDoc.close();
	const send = (data: unknown, source: unknown = win.parent) =>
		win.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
	return { win, app, posted, send, draw };
}

const types = (posted: unknown[]) =>
	posted.map((message) => (message as { type: string }).type);

describe("startWrapper", () => {
	it("makes no inner frame when opened as a normal page", () => {
		const outer = document.createElement("iframe");
		document.body.append(outer);
		const win = outer.contentWindow as Window;
		Object.defineProperty(win, "parent", { value: win });
		startWrapper(win);
		expect(win.document.querySelector("iframe")).toBeNull();
		expect(win.document.body.textContent).toBe(STANDALONE_MESSAGE);
	});

	it("holds the app at / with the preview's allow list, and posts nothing on load", () => {
		const { app, posted } = mount();
		expect(app.getAttribute("src")).toBe("/");
		expect(app.allow).toBe(PREVIEW_FRAME_ALLOW);
		app.dispatchEvent(new Event("load"));
		app.dispatchEvent(new Event("load"));
		expect(posted).toEqual([]);
	});

	it("leaves pick mode and posts cancelled when the app loads a new page", () => {
		const { win, app, send, posted } = mount();
		app.dispatchEvent(new Event("load"));
		send({ v: 1, type: "start" });
		expect(win.document.querySelector(".pick-layer")).not.toBeNull();
		app.dispatchEvent(new Event("load"));
		expect(win.document.querySelector(".pick-layer")).toBeNull();
		expect(types(posted)).toEqual(["cancelled"]);
		// The next start reads the new page.
		send({ v: 1, type: "start" });
		expect(win.document.querySelector(".pick-layer")).not.toBeNull();
	});

	it("posts cancelled when the pick cannot be built", async () => {
		const { win, send, posted } = mount(
			vi.fn(async () => {
				throw new Error("draw failed");
			}),
		);
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(types(posted)).toContain("cancelled"));
		expect(types(posted)).not.toContain("picked");
	});

	it("starts the keyboard at the app's last focused element after focus left the frame", async () => {
		const { win, app, send, posted } = mount();
		app.dispatchEvent(new Event("load"));
		const appDoc = app.contentDocument as Document;
		appDoc.body.innerHTML = `<button id="b">B</button><p>Other</p>`;
		const button = appDoc.querySelector("button") as HTMLElement;
		button.focus();
		// Pressing the Portikus button moves focus out; the app's body reads as focused.
		button.blur();
		expect(appDoc.activeElement).toBe(appDoc.body);
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(types(posted)).toContain("picked"));
		const pick = posted.find((m) => (m as { type: string }).type === "picked");
		expect(pick).toMatchObject({ selector: "#b" });
	});

	it("starts at the body when the last focused element is gone", async () => {
		const { win, app, send, posted } = mount();
		app.dispatchEvent(new Event("load"));
		const appDoc = app.contentDocument as Document;
		appDoc.body.innerHTML = `<button id="b">B</button>`;
		const button = appDoc.querySelector("button") as HTMLElement;
		button.focus();
		button.remove();
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(types(posted)).toContain("picked"));
		const pick = posted.find((m) => (m as { type: string }).type === "picked");
		expect(pick).toMatchObject({ tag: "body" });
	});

	it("ignores start from any source other than its parent", () => {
		const { win, send } = mount();
		send({ v: 1, type: "start" }, win);
		send({ v: 1, type: "start" }, null);
		expect(win.document.querySelector(".pick-layer")).toBeNull();
	});

	it("ignores a start that does not fit the schema", () => {
		const { win, send } = mount();
		send({ v: 2, type: "start" });
		send({ v: 1, type: "start", extra: true });
		expect(win.document.querySelector(".pick-layer")).toBeNull();
	});

	it("ignores stop from another source, and leaves on stop from its parent", () => {
		const { win, send, posted } = mount();
		send({ v: 1, type: "start" });
		send({ v: 1, type: "stop" }, win);
		expect(win.document.querySelector(".pick-layer")).not.toBeNull();
		send({ v: 1, type: "stop" });
		expect(win.document.querySelector(".pick-layer")).toBeNull();
		expect(types(posted)).not.toContain("cancelled");
	});

	it("starts only one pick mode at a time", () => {
		const { win, send } = mount();
		send({ v: 1, type: "start" });
		send({ v: 1, type: "start" });
		expect(win.document.querySelectorAll(".pick-layer")).toHaveLength(1);
	});

	it("posts cancelled on Escape", () => {
		const { win, send, posted } = mount();
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(types(posted)).toContain("cancelled");
		expect(win.document.querySelector(".pick-layer")).toBeNull();
	});

	it("posts one valid pick per start, with the picture when there is one", async () => {
		const png = new ArrayBuffer(16);
		const { win, app, send, posted, draw } = mount(vi.fn(async () => png));
		const appDoc = app.contentDocument as Document;
		appDoc.body.innerHTML = `<button id="b">B</button>`;
		(appDoc.querySelector("button") as HTMLElement).focus();
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(types(posted)).toContain("picked"));
		const picks = posted.filter((m) => (m as { type: string }).type === "picked");
		expect(picks).toHaveLength(1);
		expect(parseWrapperMessage(picks[0])).toMatchObject({ selector: "#b", png });
		expect(draw).toHaveBeenCalledOnce();
		expect(png.byteLength).toBeLessThan(PICK_PNG_MAX_BYTES);
	});

	it("posts the pick without a picture when none was drawn", async () => {
		const { win, send, posted } = mount();
		send({ v: 1, type: "start" });
		const layer = win.document.querySelector(".pick-layer") as HTMLElement;
		layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(types(posted)).toContain("picked"));
		const pick = posted.find((m) => (m as { type: string }).type === "picked");
		expect(pick).not.toHaveProperty("png");
	});
});
