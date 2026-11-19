import { afterEach, describe, expect, it } from "vitest";
import { PICK_SELECTOR_MAX_CHARS } from "../pick/messages.js";
import { uniqueSelector } from "./selector.js";

afterEach(() => {
	document.body.innerHTML = "";
});

function expectUnique(element: Element) {
	const selector = uniqueSelector(element);
	const found = document.querySelectorAll(selector);
	expect(found).toHaveLength(1);
	expect(found[0]).toBe(element);
	return selector;
}

describe("uniqueSelector", () => {
	it("uses a unique id", () => {
		document.body.innerHTML = `<div><button id="save">Save</button></div>`;
		expect(expectUnique(document.querySelector("button") as Element)).toBe("#save");
	});

	it("escapes an id that is not a plain identifier", () => {
		document.body.innerHTML = `<p id="1 odd:id">x</p>`;
		expectUnique(document.querySelector("p") as Element);
	});

	it("does not trust an id that appears twice", () => {
		document.body.innerHTML = `<span id="a"></span><span id="a"></span>`;
		expectUnique(document.querySelectorAll("span")[1] as Element);
	});

	it("uses a unique first class", () => {
		document.body.innerHTML = `<a class="cta big"></a><a class="other"></a>`;
		expect(expectUnique(document.querySelector("a") as Element)).toBe("a.cta");
	});

	it("builds a path with nth-of-type among same-tag siblings", () => {
		document.body.innerHTML = `<ul><li>1</li><li>2</li><li>3</li></ul><ul><li>4</li></ul>`;
		const third = document.querySelectorAll("li")[2] as Element;
		expect(expectUnique(third)).toContain("li:nth-of-type(3)");
		expectUnique(document.querySelectorAll("li")[3] as Element);
	});

	it("anchors on the nearest ancestor id", () => {
		document.body.innerHTML = `<section id="main"><p>a</p><p>b</p></section><p>c</p><p>d</p>`;
		expect(expectUnique(document.querySelectorAll("p")[1] as Element)).toBe(
			"#main > p:nth-of-type(2)",
		);
	});

	it("stays within the length limit", () => {
		let html = "";
		for (let i = 0; i < 400; i++) html += "<div><span></span><span>";
		document.body.innerHTML = html;
		const deepest = document.querySelectorAll("span");
		const selector = uniqueSelector(deepest[deepest.length - 1] as Element);
		expect(selector.length).toBeLessThanOrEqual(PICK_SELECTOR_MAX_CHARS);
	});
});
