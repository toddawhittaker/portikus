import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals here, so React Testing Library cannot register its
// own automatic cleanup. Unmount between tests so queries see one render at a time.
afterEach(cleanup);

// jsdom lacks the browser APIs Radix and react-resizable-panels reach for.
if (!globalThis.ResizeObserver) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

if (!globalThis.DOMRect) {
	globalThis.DOMRect = class {
		constructor(
			public x = 0,
			public y = 0,
			public width = 0,
			public height = 0,
		) {}
		top = 0;
		left = 0;
		right = 0;
		bottom = 0;
		toJSON() {
			return this;
		}
	} as unknown as typeof DOMRect;
}

if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => {};
	Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}
