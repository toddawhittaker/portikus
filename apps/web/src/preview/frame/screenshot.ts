import { domToCanvas } from "modern-screenshot";
import { PICK_PNG_MAX_BYTES } from "../pick/messages.js";

/** The largest box drawn, in CSS pixels; anything beyond it is clipped. */
export const SCREENSHOT_MAX_CSS_PIXELS = 2000;
const MAX_SCALE = 2;

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
		const scale = Math.min(view?.devicePixelRatio ?? 1, MAX_SCALE);
		const drawn = await domToCanvas(element, {
			scale,
			// The library fetches images and fonts the element uses; it must not
			// send the student's cookies to other sites (SPEC.md section 24).
			fetch: { requestInit: { credentials: "omit" } },
		});
		const limit = Math.round(SCREENSHOT_MAX_CSS_PIXELS * scale);
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
