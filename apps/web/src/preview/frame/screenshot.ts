import { domToCanvas } from "modern-screenshot";
import { PICK_PNG_MAX_BYTES } from "../pick/messages.js";

/** The largest box drawn, in CSS pixels; anything beyond it is clipped. */
export const SCREENSHOT_MAX_CSS_PIXELS = 2000;
const MAX_SCALE = 2;
/**
 * The longest side of the PNG, in device pixels. The chat's attach step
 * re-encodes a larger picture under another name, and the Markdown names
 * picked-element.png, so the picture must never be larger than this.
 */
export const SCREENSHOT_MAX_DEVICE_PIXELS = 2000;

function toPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * The element drawn into a PNG, or undefined when it cannot be drawn or is
 * too large. A missing picture never stops the pick.
 */
export async function drawElement(element: Element): Promise<ArrayBuffer | undefined> {
	try {
		const view = element.ownerDocument.defaultView;
		const rect = element.getBoundingClientRect();
		const longest = Math.min(
			Math.max(rect.width, rect.height, 1),
			SCREENSHOT_MAX_CSS_PIXELS,
		);
		const scale = Math.min(
			view?.devicePixelRatio ?? 1,
			MAX_SCALE,
			SCREENSHOT_MAX_DEVICE_PIXELS / longest,
		);
		const drawn = await domToCanvas(element, {
			scale,
			// The library fetches the images and fonts the element uses. Same-origin
			// requests carry the preview cookie so the app's own files load; the
			// wrapper's CSP blocks requests to other sites (SPEC.md section 24).
			// This object replaces the library's default, so the cache is set too.
			fetch: { requestInit: { credentials: "same-origin", cache: "force-cache" } },
		});
		const limit = Math.min(
			Math.round(SCREENSHOT_MAX_CSS_PIXELS * scale),
			SCREENSHOT_MAX_DEVICE_PIXELS,
		);
		let canvas = drawn;
		if (drawn.width > limit || drawn.height > limit) {
			canvas = element.ownerDocument.createElement("canvas");
			canvas.width = Math.min(drawn.width, limit);
			canvas.height = Math.min(drawn.height, limit);
			canvas.getContext("2d")?.drawImage(drawn, 0, 0);
		}
		const blob = await toPng(canvas);
		if (!blob || blob.size > PICK_PNG_MAX_BYTES) return undefined;
		return await blob.arrayBuffer();
	} catch {
		return undefined;
	}
}
