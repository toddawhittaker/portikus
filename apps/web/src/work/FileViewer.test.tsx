/**
 * The image and PDF viewers of a file tab (#816): what they show, and the
 * download panel they fall back to when they cannot show the file.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ImageView, MAX_PDF_VIEW_BYTES, PdfView } from "./FileViewer.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const fallback = (title: string) => <p>{title}</p>;

test("an image shows its dimensions once loaded, and its size", () => {
	render(
		<ImageView
			src="/a.png"
			path="img/a.png"
			size={2048}
			download={<button type="button">Download</button>}
			fallback={fallback}
		/>,
	);
	const image = screen.getByRole("img", { name: "a.png" });
	expect(screen.queryByTestId("file-image-dimensions")).toBeNull();
	Object.defineProperty(image, "naturalWidth", { value: 640 });
	Object.defineProperty(image, "naturalHeight", { value: 480 });
	fireEvent.load(image);
	expect(screen.getByTestId("file-image-dimensions").textContent).toBe(
		"640 × 480 pixels",
	);
	expect(screen.getByText("2.0 KB")).not.toBeNull();
	// Only the facts name the figure; Download sits beside the caption, not in it.
	const figure = image.closest("figure");
	const caption = figure?.querySelector("figcaption");
	expect(caption?.textContent).toContain("640 × 480 pixels");
	expect(caption?.querySelector("button")).toBeNull();
	expect(figure?.lastElementChild).toBe(caption);
	expect(screen.getByRole("figure").textContent).toContain("Download");
});

test("a new address is a new image: an old failure does not stick", () => {
	const { rerender } = render(
		<ImageView src="/a.png?v=1" path="a.png" download={null} fallback={fallback} />,
	);
	fireEvent.error(screen.getByRole("img"));
	expect(screen.getByText("This image could not be shown")).not.toBeNull();
	rerender(
		<ImageView src="/a.png?v=2" path="a.png" download={null} fallback={fallback} />,
	);
	expect(screen.getByRole("img", { name: "a.png" })).not.toBeNull();
});

function stubFetch(response: Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response),
	);
}

test("a PDF larger than the viewer's limit is offered as a download", async () => {
	stubFetch(
		new Response("x", {
			status: 200,
			headers: { "content-length": String(MAX_PDF_VIEW_BYTES + 1) },
		}),
	);
	render(<PdfView url="/b.pdf" path="b.pdf" download={null} fallback={fallback} />);
	expect(await screen.findByText("This PDF is too large to show here")).not.toBeNull();
});

test("a PDF with no stated size is not copied into the page", async () => {
	const response = new Response("x", { status: 200 });
	response.headers.delete("content-length");
	stubFetch(response);
	render(<PdfView url="/b.pdf" path="b.pdf" download={null} fallback={fallback} />);
	expect(
		await screen.findByText("This PDF's size is unknown, so it is not shown here"),
	).not.toBeNull();
});

test("a PDF within the limit opens in the page's viewer", async () => {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	stubFetch(new Response("%PDF", { status: 200, headers: { "content-length": "4" } }));
	render(<PdfView url="/b.pdf" path="b.pdf" download={null} fallback={fallback} />);
	expect((await screen.findByTitle("b.pdf, PDF")).getAttribute("src")).toBe("blob:pdf");
});

test("a PDF the server refuses falls back to the download panel", async () => {
	stubFetch(new Response("{}", { status: 404 }));
	render(<PdfView url="/b.pdf" path="b.pdf" download={null} fallback={fallback} />);
	expect(await screen.findByText("This PDF could not be shown")).not.toBeNull();
});

test("a PDF shows a loading line until its copy is ready", () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => new Promise(() => {})),
	);
	render(<PdfView url="/b.pdf" path="b.pdf" download={null} fallback={fallback} />);
	expect(screen.getByText("Loading…")).not.toBeNull();
});
