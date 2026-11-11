import { describe, expect, it } from "vitest";
import {
	BASE_FONT_SIZE,
	clampZoom,
	DEFAULT_ZOOM,
	fontSizeFor,
	MAX_ZOOM,
	MIN_ZOOM,
	stepZoom,
	wheelZoom,
	zoomKey,
} from "./zoom.js";

/** Pane zoom state (SPEC.md §13.1). */
describe("zoom", () => {
	it("starts at 100%", () => {
		expect(DEFAULT_ZOOM).toBe(100);
		expect(fontSizeFor(DEFAULT_ZOOM)).toBe(BASE_FONT_SIZE);
	});

	it("steps by ten percent in each direction", () => {
		expect(stepZoom(100, 1)).toBe(110);
		expect(stepZoom(100, -1)).toBe(90);
		expect(stepZoom(100, 3)).toBe(130);
	});

	it("stops at the ends of the range", () => {
		expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
		expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
		expect(clampZoom(1000)).toBe(MAX_ZOOM);
		expect(clampZoom(0)).toBe(MIN_ZOOM);
	});

	it("falls back to 100% for a value that is not a number", () => {
		expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
	});

	it("turns a percentage into a whole font size", () => {
		expect(fontSizeFor(200)).toBe(BASE_FONT_SIZE * 2);
		expect(fontSizeFor(50)).toBe(Math.round(BASE_FONT_SIZE / 2));
		expect(Number.isInteger(fontSizeFor(115))).toBe(true);
	});
});

function wheel(init: WheelEventInit): WheelEvent {
	return new WheelEvent("wheel", { cancelable: true, ...init });
}

/** Ctrl + wheel and a pinch zoom the pane, never the page (SPEC.md §13.1, §20.1). */
describe("wheelZoom", () => {
	it("leaves a plain wheel to scroll", () => {
		const steps: number[] = [];
		const event = wheel({ deltaY: -100 });
		wheelZoom((step) => steps.push(step))(event);
		expect(steps).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
	});

	it("steps once per notch with Ctrl or Cmd, and takes the event", () => {
		const steps: number[] = [];
		const onWheel = wheelZoom((step) => steps.push(step));
		const up = wheel({ deltaY: -120, ctrlKey: true });
		onWheel(up);
		onWheel(wheel({ deltaY: 100, metaKey: true }));
		onWheel(wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE, ctrlKey: true }));
		expect(steps).toEqual([1, -1, -1]);
		expect(up.defaultPrevented).toBe(true);
	});

	it("adds up the small deltas of a pinch into steady steps", () => {
		const steps: number[] = [];
		const onWheel = wheelZoom((step) => steps.push(step));
		for (let i = 0; i < 20; i += 1) onWheel(wheel({ deltaY: -5, ctrlKey: true }));
		expect(steps).toEqual([1, 1]);
	});

	it("takes a sideways-only Ctrl wheel without stepping", () => {
		const steps: number[] = [];
		const event = wheel({ deltaX: 40, ctrlKey: true });
		wheelZoom((step) => steps.push(step))(event);
		expect(steps).toEqual([]);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe("zoomKey", () => {
	const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
		zoomKey({
			code,
			ctrlKey: true,
			metaKey: false,
			altKey: false,
			shiftKey: false,
			...mods,
		});

	it("reads the editor's keys", () => {
		expect(key("Equal", { shiftKey: true })).toBe("in");
		expect(key("Minus", { shiftKey: true })).toBe("out");
		expect(key("Digit0")).toBe("reset");
		expect(key("Equal", { shiftKey: true, ctrlKey: false, metaKey: true })).toBe("in");
	});

	it("leaves Ctrl+= and Ctrl+- without Shift, and other keys, alone", () => {
		expect(key("Equal")).toBeNull();
		expect(key("Minus")).toBeNull();
		expect(key("Digit0", { shiftKey: true })).toBeNull();
		expect(key("Equal", { shiftKey: true, altKey: true })).toBeNull();
		expect(key("Equal", { shiftKey: true, ctrlKey: false })).toBeNull();
	});
});
