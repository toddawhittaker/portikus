import { afterEach, describe, expect, it, vi } from "vitest";
import { PICK_PNG_MAX_BYTES } from "../pick/messages.js";

const domToCanvas = vi.fn();
vi.mock("modern-screenshot", () => ({ domToCanvas }));
const { drawElement, SCREENSHOT_MAX_CSS_PIXELS } = await import("./screenshot.js");

interface FakeCanvas {
	width: number;
	height: number;
	toBlob: (done: (blob: Blob | null) => void) => void;
	getContext: () => { drawImage: () => void } | null;
}

function fakeCanvas(width: number, height: number, bytes = 10): FakeCanvas {
	return {
		width,
		height,
		toBlob: (done) => done(new Blob([new Uint8Array(bytes)], { type: "image/png" })),
		getContext: () => ({ drawImage: vi.fn() }),
	};
}

afterEach(() => {
	domToCanvas.mockReset();
	vi.restoreAllMocks();
});

describe("drawElement", () => {
	it("draws at the device scale, capped at 2, with no credentials", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
		domToCanvas.mockResolvedValue(fakeCanvas(100, 50));
		const png = await drawElement(document.body);
		expect(png?.byteLength).toBe(10);
		expect(domToCanvas).toHaveBeenCalledWith(document.body, {
			scale: 2,
			fetch: { requestInit: { credentials: "omit" } },
		});
	});

	it("clips a box larger than the limit", async () => {
		const clipped = fakeCanvas(0, 0, 5);
		vi.spyOn(document, "createElement").mockReturnValue(
			clipped as unknown as HTMLCanvasElement,
		);
		domToCanvas.mockResolvedValue(fakeCanvas(SCREENSHOT_MAX_CSS_PIXELS + 1, 10));
		const png = await drawElement(document.body);
		expect(clipped.width).toBe(SCREENSHOT_MAX_CSS_PIXELS);
		expect(clipped.height).toBe(10);
		expect(png?.byteLength).toBe(5);
	});

	it("sends no picture when the PNG is over the limit", async () => {
		domToCanvas.mockResolvedValue(fakeCanvas(10, 10, PICK_PNG_MAX_BYTES + 1));
		expect(await drawElement(document.body)).toBeUndefined();
	});

	it("sends no picture when drawing fails", async () => {
		domToCanvas.mockRejectedValue(new Error("tainted"));
		expect(await drawElement(document.body)).toBeUndefined();
	});
});
