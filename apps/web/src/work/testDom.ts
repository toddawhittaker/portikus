/**
 * Test-only: the browser APIs jsdom does not have but Radix, dnd-kit,
 * react-resizable-panels and xterm.js all reach for. Imported by the tests in
 * this folder, never by the app.
 */
export function installBrowserStubs(): void {
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (!globalThis.matchMedia) {
		globalThis.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as unknown as typeof matchMedia;
	}
	if (!Element.prototype.hasPointerCapture) {
		Element.prototype.hasPointerCapture = () => false;
		Element.prototype.setPointerCapture = () => {};
		Element.prototype.releasePointerCapture = () => {};
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
}
