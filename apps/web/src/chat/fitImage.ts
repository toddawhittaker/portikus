/**
 * A pasted or attached picture is made small enough for Claude before it is
 * saved: at most 2000 px on its long side and under the chat's image cap
 * (SPEC.md §10.8). It is re-encoded as WebP, or JPEG where the browser cannot
 * write WebP, and kept as PNG when that is smaller. It is never enlarged, and
 * a picture that already fits is left exactly as it was.
 */
import { MAX_CHAT_IMAGE_BYTES } from "@portikus/contracts";

/** Claude scales anything larger down itself, so more pixels only cost bytes. */
const MAX_IMAGE_SIDE = 2000;

/** Pictures this can redraw; a GIF would lose its animation, so it is left alone. */
const SCALABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Lossy qualities tried in turn until the picture fits. */
const QUALITIES = [0.9, 0.8, 0.65, 0.5];

const EXTENSION: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

/** The size that fits `max` on the long side, never larger than the original. */
export function fittedSize(
	width: number,
	height: number,
	max = MAX_IMAGE_SIDE,
): { width: number; height: number } {
	const scale = Math.min(1, max / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

interface Surface {
	draw: (image: ImageBitmap, width: number, height: number, ground: boolean) => void;
	encode: (type: string, quality?: number) => Promise<Blob | null>;
}

function surface(width: number, height: number): Surface | null {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) return null;
		return {
			draw: (image, w, h, ground) => paint(context, image, w, h, ground),
			encode: (type, quality) =>
				canvas.convertToBlob({ type, quality }).catch(() => null),
		};
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) return null;
	return {
		draw: (image, w, h, ground) => paint(context, image, w, h, ground),
		encode: (type, quality) =>
			new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
	};
}

function paint(
	context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
	image: ImageBitmap,
	width: number,
	height: number,
	ground: boolean,
) {
	context.clearRect(0, 0, width, height);
	// JPEG has no transparency; a white ground reads better than black.
	if (ground) {
		context.fillStyle = "#fff";
		context.fillRect(0, 0, width, height);
	}
	context.drawImage(image, 0, 0, width, height);
}

function renamed(name: string, type: string): string {
	const base = name.replace(/\.[^.]+$/, "") || "pasted";
	return `${base}.${EXTENSION[type] ?? "png"}`;
}

/**
 * The picture to attach: the same file when it already fits or cannot be
 * redrawn, a smaller one when it was too large, or null when even the
 * smallest encoding is over the cap.
 */
export async function fitImage(file: File): Promise<File | null> {
	if (!SCALABLE.has(file.type) || typeof createImageBitmap === "undefined") return file;
	let image: ImageBitmap;
	try {
		image = await createImageBitmap(file);
	} catch {
		// Not a picture the browser can read; the size check decides.
		return file;
	}
	try {
		const size = fittedSize(image.width, image.height);
		const shrinks = size.width < image.width || size.height < image.height;
		if (!shrinks && file.size <= MAX_CHAT_IMAGE_BYTES) return file;
		const canvas = surface(size.width, size.height);
		if (!canvas) return file;
		const candidates: Blob[] = [];
		canvas.draw(image, size.width, size.height, false);
		const png = await canvas.encode("image/png");
		if (png) candidates.push(png);
		for (const quality of QUALITIES) {
			let lossy = await canvas.encode("image/webp", quality);
			// A browser that cannot write WebP hands back a PNG instead.
			if (lossy?.type !== "image/webp") {
				canvas.draw(image, size.width, size.height, true);
				lossy = await canvas.encode("image/jpeg", quality);
				canvas.draw(image, size.width, size.height, false);
			}
			if (lossy) candidates.push(lossy);
			if (candidates.some((blob) => blob.size <= MAX_CHAT_IMAGE_BYTES)) break;
		}
		const fits = candidates
			.filter((blob) => blob.size <= MAX_CHAT_IMAGE_BYTES && SCALABLE.has(blob.type))
			.sort((a, b) => a.size - b.size)[0];
		if (!fits) return null;
		return new File([fits], renamed(file.name, fits.type), { type: fits.type });
	} finally {
		image.close();
	}
}
