import { afterEach, describe, expect, it, vi } from "vitest";
import { PICK_PNG_MAX_BYTES } from "../pick/messages.js";

const domToCanvas = vi.fn();
vi.mock("modern-screenshot", () => ({ domToCanvas }));
const { drawElement, SCREENSHOT_MAX_CSS_PIXELS, SCREENSHOT_MAX_DEVICE_PIXELS } =
	await import("./screenshot.js");

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
	it("draws at the device scale, capped at 2, sending cookies only to its own origin", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
		domToCanvas.mockResolvedValue(fakeCanvas(100, 50));
		const png = await drawElement(document.body);
		expect(png?.byteLength).toBe(10);
		expect(domToCanvas).toHaveBeenCalledWith(document.body, {
			scale: 2,
			fetch: { requestInit: { credentials: "same-origin", cache: "force-cache" } },
		});
	});

	function sized(width: number, height: number): Element {
		const element = document.createElement("div");
		element.getBoundingClientRect = () => ({ width, height }) as DOMRect;
		return element;
	}

	it("lowers the scale so the longest side stays within the device pixel limit", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
		domToCanvas.mockResolvedValue(fakeCanvas(10, 10));
		await drawElement(sized(1500, 100));
		expect(domToCanvas.mock.calls[0]?.[1].scale).toBeCloseTo(
			SCREENSHOT_MAX_DEVICE_PIXELS / 1500,
		);
		await drawElement(sized(100, 5000));
		expect(domToCanvas.mock.calls[1]?.[1].scale).toBe(1);
		await drawElement(sized(800, 600));
		expect(domToCanvas.mock.calls[2]?.[1].scale).toBe(2);
	});

	it("never clips to more than the device pixel limit", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
		const clipped = fakeCanvas(0, 0, 5);
		const element = sized(100, 100);
		vi.spyOn(document, "createElement").mockReturnValue(
			clipped as unknown as HTMLCanvasElement,
		);
		domToCanvas.mockResolvedValue(fakeCanvas(4000, 10));
		await drawElement(element);
		expect(clipped.width).toBe(SCREENSHOT_MAX_DEVICE_PIXELS);
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
