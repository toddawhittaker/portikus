import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { type LayoutStore, LayoutStoreContext } from "../layout/store.js";
import { ImageViewerProvider, useChatImages, type ViewerImage } from "./ImageViewer.js";

afterEach(cleanup);

/** A button that opens `image`, the way a reply or a tool block does. */
function Opener({ image }: { image: ViewerImage }) {
	const images = useChatImages();
	return (
		<button type="button" onClick={() => images?.open(image)}>
			Open
		</button>
	);
}

function draw(image: ViewerImage, openFile = vi.fn()) {
	const layout = { getState: () => ({ openFile }) } as unknown as LayoutStore;
	render(
		<LayoutStoreContext.Provider value={layout}>
			<ImageViewerProvider workspaceId="w1" projectId="p1">
				<Opener image={image} />
			</ImageViewerProvider>
		</LayoutStoreContext.Provider>,
	);
	return openFile;
}

const PROJECT_IMAGE: ViewerImage = {
	src: "/workspaces/w1/projects/p1/image?path=shot.png",
	name: "shot.png",
	alt: "A screenshot",
	projectPath: ".portikus/images/shot.png",
};

test("the viewer is a named dialog that Escape closes, giving focus back", async () => {
	draw(PROJECT_IMAGE);
	const opener = screen.getByRole("button", { name: "Open" });
	opener.focus();
	fireEvent.click(opener);
	const dialog = await screen.findByRole("dialog", { name: "shot.png" });
	expect(dialog.contains(document.activeElement)).toBe(true);
	expect(screen.getByRole("img", { name: "A screenshot" }).getAttribute("src")).toBe(
		PROJECT_IMAGE.src,
	);
	fireEvent.keyDown(dialog, { key: "Escape" });
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(document.activeElement).toBe(opener);
});

test("Close closes the viewer", async () => {
	draw(PROJECT_IMAGE);
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
	await screen.findByRole("dialog");
	const closers = screen.getAllByRole("button", { name: "Close" });
	fireEvent.click(closers.at(-1) as HTMLElement);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Open in editor opens a project image in a tab", async () => {
	const openFile = draw(PROJECT_IMAGE);
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
	fireEvent.click(await screen.findByRole("button", { name: "Open in editor" }));
	expect(openFile).toHaveBeenCalledWith(".portikus/images/shot.png");
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an image outside the project, or a tool's, has no Open in editor", async () => {
	draw({
		src: "data:image/png;base64,AAAA",
		name: "Output of Read",
		alt: "Output of Read",
	});
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
	await screen.findByRole("dialog", { name: "Output of Read" });
	expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
});
