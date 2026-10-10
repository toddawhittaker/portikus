/**
 * Monaco's colorize output is HTML, and the preview runs on the app's origin
 * with the student's file as untrusted input (SPEC.md §24.2, §24.3), so only
 * token class names and text may come out of it.
 */
import { expect, test } from "vitest";
import { tokenRuns } from "./highlight.js";

test("token spans keep their class, lines become newlines and spaces stay spaces", () => {
	const html =
		'<div class="monaco-tokenized-source"><span><span class="mtk6">const</span><span class="mtk1"> x = </span><span class="mtk7 mtki">1</span></span><br/><span><span class="mtk1">x</span></span><br/></div>';
	expect(tokenRuns(html)).toEqual([
		{ className: "mtk6", text: "const" },
		{ className: "mtk1", text: " x = " },
		{ className: "mtk7 mtki", text: "1" },
		{ text: "\n" },
		{ className: "mtk1", text: "x" },
	]);
});

test("escaped markup in the code comes out as its text", () => {
	const html =
		'<span><span class="mtk1">&lt;img src=x onerror=alert(1)&gt;</span></span><br/>';
	expect(tokenRuns(html)).toEqual([
		{ className: "mtk1", text: "<img src=x onerror=alert(1)>" },
	]);
});

test("any other element, attribute or class is dropped, keeping only text", () => {
	const html = [
		'<img src="x" onerror="window.ran=1">',
		'<span class="mtk1" onclick="window.ran=1" style="color:red">a</span>',
		'<span class="mtk1 evil">b</span>',
		'<a href="javascript:alert(1)">c</a>',
		"<script>window.ran=1</script>",
	].join("");
	const runs = tokenRuns(html);
	expect(runs).toEqual([{ className: "mtk1", text: "a" }, { text: "bcwindow.ran=1" }]);
	expect((window as { ran?: number }).ran).toBeUndefined();
});
