import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PICK_RULES_MAX_CHARS,
	PICK_RULES_MAX_COUNT,
	PickedMessage,
	ruleChars,
} from "../pick/messages.js";
import { capturePick, matchingRules } from "./capture.js";

afterEach(() => {
	document.head.innerHTML = "";
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function addStyle(css: string) {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
}

describe("matchingRules", () => {
	it("keeps matching rules with their media condition and skips the rest", () => {
		addStyle(`.a{color:red} .b{color:blue} @media (min-width: 10px){ p.a{margin:0} }`);
		document.body.innerHTML = `<p class="a">x</p>`;
		const { rules, trimmed } = matchingRules(document.querySelector("p") as Element);
		expect(trimmed).toBe(false);
		expect(rules).toEqual([
			{ kind: "rule", selector: ".a", declarations: "color: red;" },
			{
				kind: "rule",
				selector: "p.a",
				declarations: "margin: 0px;",
				media: "(min-width: 10px)",
			},
		]);
	});

	it("lists a sheet it may not read as unreadable", () => {
		const sheet = {
			href: "https://cdn.example/x.css",
			get cssRules(): never {
				throw new DOMException("no", "SecurityError");
			},
		};
		vi.spyOn(document, "styleSheets", "get").mockReturnValue([
			sheet,
		] as unknown as StyleSheetList);
		document.body.innerHTML = `<p></p>`;
		expect(matchingRules(document.querySelector("p") as Element).rules).toEqual([
			{ kind: "unreadable", sheet: "https://cdn.example/x.css" },
		]);
	});

	it("stops at the rule count limit", () => {
		addStyle(
			Array.from({ length: PICK_RULES_MAX_COUNT + 5 }, () => "p{color:red}").join(""),
		);
		document.body.innerHTML = `<p></p>`;
		const result = matchingRules(document.querySelector("p") as Element);
		expect(result.rules).toHaveLength(PICK_RULES_MAX_COUNT);
		expect(result.trimmed).toBe(true);
	});

	it("stops at the character limit", () => {
		const long = `p{background-image:url("${"x".repeat(2_000)}")}`;
		addStyle(Array.from({ length: 20 }, () => long).join(""));
		document.body.innerHTML = `<p></p>`;
		const result = matchingRules(document.querySelector("p") as Element);
		const total = result.rules.reduce((sum, rule) => sum + ruleChars(rule), 0);
		expect(total).toBeLessThanOrEqual(PICK_RULES_MAX_CHARS);
		expect(result.trimmed).toBe(true);
	});

	it("ignores a selector the browser cannot match", () => {
		addStyle(`p{color:red}`);
		document.body.innerHTML = `<p></p>`;
		const element = document.querySelector("p") as Element;
		vi.spyOn(element, "matches").mockImplementation(() => {
			throw new Error("bad selector");
		});
		expect(matchingRules(element).rules).toEqual([]);
	});
});

describe("capturePick", () => {
	it("builds a message the Portikus page accepts", () => {
		addStyle(`button{color:red}`);
		document.body.innerHTML = `<button id="go" style="padding: 2px">Go</button>`;
		const pick = capturePick(document.querySelector("button") as Element);
		expect(PickedMessage.safeParse(pick).success).toBe(true);
		expect(pick).toMatchObject({
			selector: "#go",
			tag: "button",
			pagePath: "/",
			trimmed: { html: false, rules: false },
		});
		expect(pick.computed.color).toBe("rgb(255, 0, 0)");
		expect(pick.rules).toHaveLength(1);
	});

	it("names a tag that does not fit the format as element", () => {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
		document.body.append(svg);
		expect(capturePick(svg).tag).toBe("foreignobject");
		const odd = document.createElementNS("urn:x", "x:Ünicode");
		document.body.append(odd);
		expect(capturePick(odd).tag).toBe("element");
	});
});
