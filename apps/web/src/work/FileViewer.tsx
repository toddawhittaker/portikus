/**
 * The file tab's viewers for images and PDFs (#816). An image, SVG included,
 * is only ever drawn through `img`, where a script in it cannot run. A PDF
 * goes to the browser's own viewer as a copy held in the page, so its frame
 * never loads a document from the app's address.
 */
import { type ReactNode, useEffect, useState } from "react";
import { baseName } from "../files/paths.js";

/** PDFs up to this size are shown; a larger one is offered as a download. */
export const MAX_PDF_VIEW_BYTES = 50 * 1024 * 1024;

/** A byte count a student can read. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a viewer shows when it cannot show the file: a title for the download panel. */
export type ViewerFallback = (title: string) => ReactNode;

export interface ImageViewProps {
	/** The image's address; a new one is a new image. */
	src: string;
	path: string;
	/** Bytes on disk, when known. */
	size?: number;
	/** The Download control. */
	download: ReactNode;
	fallback: ViewerFallback;
}

/** An image fit to the pane, with its dimensions and size under it. */
export function ImageView({ src, path, size, download, fallback }: ImageViewProps) {
	const [loaded, setLoaded] = useState<{
		src: string;
		width: number;
		height: number;
	} | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	if (failed === src) return fallback("This image could not be shown");
	// Measurements belong to the address they were taken from.
	const dims = loaded?.src === src ? loaded : null;
	return (
		<figure
			className="pk-file-viewer pk-file-viewer--image"
			data-testid={`file-image-${path}`}
		>
			<div className="pk-file-viewer-stage">
				<img
					src={src}
					alt={baseName(path)}
					onLoad={(event) =>
						setLoaded({
							src,
							width: event.currentTarget.naturalWidth,
							height: event.currentTarget.naturalHeight,
						})
					}
					onError={() => setFailed(src)}
				/>
			</div>
			{/* Download sits beside the caption, not in it, so only the facts name the figure. */}
			<div className="pk-file-viewer-bar pk-file-viewer-action">{download}</div>
			<figcaption className="pk-file-viewer-bar pk-file-viewer-caption">
				<dl className="pk-file-viewer-facts">
					{dims !== null && dims.width > 0 ? (
						<div>
							<dt>Dimensions</dt>
							<dd data-testid="file-image-dimensions">
								{dims.width} × {dims.height} pixels
							</dd>
						</div>
					) : null}
					{size !== undefined && size > 0 ? (
						<div>
							<dt>Size</dt>
							<dd>{formatSize(size)}</dd>
						</div>
					) : null}
				</dl>
			</figcaption>
		</figure>
	);
}

type PdfState =
	| { status: "loading" }
	| { status: "ready"; src: string }
	| { status: "large" }
	| { status: "unsized" }
	| { status: "failed" };

export interface PdfViewProps {
	/** The inline address of the PDF. */
	url: string;
	path: string;
	download: ReactNode;
	fallback: ViewerFallback;
}

/** A PDF in the browser's built-in viewer. */
export function PdfView({ url, path, download, fallback }: PdfViewProps) {
	const [state, setState] = useState<PdfState>({ status: "loading" });
	useEffect(() => {
		const controller = new AbortController();
		let objectUrl: string | null = null;
		setState({ status: "loading" });
		fetch(url, { credentials: "same-origin", signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error(String(response.status));
				// An unknown size could be any size, so it is not buffered in the page either.
				const length = response.headers.get("content-length");
				if (length === null || !(Number(length) <= MAX_PDF_VIEW_BYTES)) {
					setState({ status: length === null ? "unsized" : "large" });
					controller.abort();
					return;
				}
				// The type is set here, not taken from the bytes, so the frame can
				// only ever hold the PDF viewer.
				const blob = new Blob([await response.arrayBuffer()], {
					type: "application/pdf",
				});
				objectUrl = URL.createObjectURL(blob);
				setState({ status: "ready", src: objectUrl });
			})
			.catch(() => {
				if (!controller.signal.aborted) setState({ status: "failed" });
			});
		return () => {
			controller.abort();
			if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
		};
	}, [url]);

	if (state.status === "large") return fallback("This PDF is too large to show here");
	if (state.status === "unsized") {
		return fallback("This PDF's size is unknown, so it is not shown here");
	}
	if (state.status === "failed") return fallback("This PDF could not be shown");
	return (
		<div className="pk-file-viewer" data-testid={`file-pdf-${path}`}>
			<div className="pk-file-viewer-stage">
				{state.status === "ready" ? (
					<iframe
						className="pk-file-viewer-pdf"
						src={state.src}
						title={`${baseName(path)}, PDF`}
					/>
				) : (
					<p className="pk-file-note">Loading…</p>
				)}
			</div>
			<div className="pk-file-viewer-bar">{download}</div>
		</div>
	);
}
