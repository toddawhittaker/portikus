import { MAX_CHAT_IMAGE_BYTES } from "@portikus/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { fitImage, fittedSize } from "./fitImage";

afterEach(() => vi.unstubAllGlobals());

function picture(name: string, type: string, size: number): File {
	const file = new File(["x"], name, { type });
	Object.defineProperty(file, "size", { value: size });
	return file;
}

/** A decoded bitmap of the given size, and a canvas whose encodings have the given sizes. */
function stubCanvas(
	bitmap: { width: number; height: number } | Error,
	sizes: Record<string, number | ((quality?: number) => number)>,
	webpType = "image/webp",
) {
	const drawn: { width: number; height: number; ground: string | null }[] = [];
	const close = vi.fn();
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => {
			if (bitmap instanceof Error) throw bitmap;
			return { ...bitmap, close };
		}),
	);
	class FakeCanvas {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			let fill: string | null = null;
			return {
				clearRect: () => {
					fill = null;
				},
				set fillStyle(value: string) {
					fill = value;
				},
				fillRect: () => {},
				drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) =>
					drawn.push({ width: w, height: h, ground: fill }),
			};
		}
		async convertToBlob({ type, quality }: { type: string; quality?: number }) {
			const size = sizes[type];
			if (size === undefined) return new Blob(["p"], { type: "image/png" });
			const bytes = typeof size === "function" ? size(quality) : size;
			const blob = new Blob(["b"], { type: type === "image/webp" ? webpType : type });
			Object.defineProperty(blob, "size", { value: bytes });
			return blob;
		}
	}
	vi.stubGlobal("OffscreenCanvas", FakeCanvas);
	return { drawn, close };
}

test("the long side is held to 2000 px, and nothing is ever enlarged", () => {
	expect(fittedSize(4000, 1000)).toEqual({ width: 2000, height: 500 });
	expect(fittedSize(1000, 3000)).toEqual({ width: 667, height: 2000 });
	expect(fittedSize(800, 600)).toEqual({ width: 800, height: 600 });
});

test("a picture that already fits is left exactly as it was", async () => {
	stubCanvas({ width: 1200, height: 800 }, {});
	const file = picture("shot.png", "image/png", 300_000);
	expect(await fitImage(file)).toBe(file);
});

test("a large picture is redrawn smaller and kept in the smaller of PNG and WebP", async () => {
	const { drawn, close } = stubCanvas(
		{ width: 4000, height: 3000 },
		{ "image/png": 3_000_000, "image/webp": 900_000 },
	);
	const fitted = await fitImage(picture("screen.png", "image/png", 9_000_000));
	expect(fitted?.name).toBe("screen.webp");
	expect(fitted?.type).toBe("image/webp");
	expect(drawn[0]).toMatchObject({ width: 2000, height: 1500 });
	expect(close).toHaveBeenCalled();
});

test("PNG is kept when it is the smaller", async () => {
	stubCanvas(
		{ width: 3000, height: 3000 },
		{ "image/png": 200_000, "image/webp": 400_000 },
	);
	const fitted = await fitImage(picture("diagram.png", "image/png", 800_000));
	expect(fitted?.type).toBe("image/png");
	expect(fitted?.name).toBe("diagram.png");
});

test("without WebP the browser's JPEG is used, drawn on white, at lower quality until it fits", async () => {
	const { drawn } = stubCanvas(
		{ width: 2500, height: 2500 },
		{
			"image/png": MAX_CHAT_IMAGE_BYTES * 3,
			"image/webp": 1,
			"image/jpeg": (quality) =>
				(quality ?? 1) > 0.7 ? MAX_CHAT_IMAGE_BYTES + 1 : 4_000_000,
		},
		"image/png",
	);
	const fitted = await fitImage(picture("photo.jpeg", "image/jpeg", 12_000_000));
	expect(fitted?.type).toBe("image/jpeg");
	expect(fitted?.name).toBe("photo.jpg");
	expect(drawn.some((draw) => draw.ground === "#fff")).toBe(true);
});

test("a picture no encoding can fit is refused", async () => {
	stubCanvas(
		{ width: 1000, height: 1000 },
		{ "image/png": MAX_CHAT_IMAGE_BYTES * 2, "image/webp": MAX_CHAT_IMAGE_BYTES * 2 },
	);
	expect(
		await fitImage(picture("noise.png", "image/png", MAX_CHAT_IMAGE_BYTES * 2)),
	).toBeNull();
});

test("a GIF, a file the browser cannot decode, and other files are left alone", async () => {
	stubCanvas(new Error("bad image"), {});
	const gif = picture("a.gif", "image/gif", 9_000_000);
	expect(await fitImage(gif)).toBe(gif);
	const broken = picture("b.png", "image/png", 9_000_000);
	expect(await fitImage(broken)).toBe(broken);
	const pdf = picture("c.pdf", "application/pdf", 9_000_000);
	expect(await fitImage(pdf)).toBe(pdf);
});

test("without bitmap decoding the file is left alone", async () => {
	vi.stubGlobal("createImageBitmap", undefined);
	const file = picture("a.png", "image/png", 9_000_000);
	expect(await fitImage(file)).toBe(file);
});
