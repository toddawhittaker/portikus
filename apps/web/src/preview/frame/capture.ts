import {
	PICK_COMPUTED_PROPERTIES,
	PICK_COMPUTED_VALUE_MAX_CHARS,
	PICK_MEDIA_MAX_CHARS,
	PICK_MESSAGE_VERSION,
	PICK_PAGE_PATH_MAX_CHARS,
	PICK_RULES_MAX_CHARS,
	PICK_RULES_MAX_COUNT,
	PICK_SELECTOR_MAX_CHARS,
	PICK_SHEET_ADDRESS_MAX_CHARS,
	PICK_TAG_MAX_CHARS,
	type PickedMessage,
	type PickRule,
	ruleChars,
} from "../pick/messages.js";
import { uniqueSelector } from "./selector.js";
import { trimHtml } from "./trim.js";

const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;

// Rules come from the inner window's realm, so `instanceof` against the
// wrapper's own CSSStyleRule would never match; these checks look at shape.
interface RuleLike {
	selectorText?: string;
	style?: { cssText: string };
	cssRules?: ArrayLike<RuleLike>;
	conditionText?: string;
	media?: { mediaText: string };
}

function matches(element: Element, selector: string): boolean {
	try {
		return element.matches(selector);
	} catch {
		return false;
	}
}

/** Rules from the page's sheets that match, within the pick limits. */
export function matchingRules(element: Element): {
	rules: PickRule[];
	trimmed: boolean;
} {
	const rules: PickRule[] = [];
	let chars = 0;
	let trimmed = false;
	const add = (rule: PickRule): boolean => {
		const size = ruleChars(rule);
		if (rules.length >= PICK_RULES_MAX_COUNT || chars + size > PICK_RULES_MAX_CHARS) {
			trimmed = true;
			return false;
		}
		rules.push(rule);
		chars += size;
		return true;
	};

	const walk = (
		list: ArrayLike<RuleLike>,
		media: string | undefined,
		sheet?: string,
	) => {
		for (const rule of Array.from(list)) {
			if (trimmed) return;
			if (rule.selectorText !== undefined && rule.style) {
				if (!matches(element, rule.selectorText)) continue;
				add({
					kind: "rule",
					selector: rule.selectorText.slice(0, PICK_SELECTOR_MAX_CHARS),
					declarations: rule.style.cssText,
					...(media ? { media: media.slice(0, PICK_MEDIA_MAX_CHARS) } : {}),
					...(sheet ? { sheet } : {}),
				});
			} else if (rule.cssRules) {
				const condition = rule.conditionText ?? rule.media?.mediaText;
				const nested = [media, condition].filter(Boolean).join(" and ");
				walk(rule.cssRules, nested || undefined, sheet);
			}
		}
	};

	for (const sheet of Array.from(element.ownerDocument.styleSheets)) {
		if (trimmed) break;
		const address = sheet.href
			? sheet.href.slice(0, PICK_SHEET_ADDRESS_MAX_CHARS)
			: undefined;
		let list: ArrayLike<RuleLike>;
		try {
			list = sheet.cssRules as unknown as ArrayLike<RuleLike>;
		} catch {
			add({ kind: "unreadable", ...(address ? { sheet: address } : {}) });
			continue;
		}
		walk(list, sheet.media?.mediaText || undefined, address);
	}
	return { rules, trimmed };
}

function computedValues(element: Element): PickedMessage["computed"] {
	const view = element.ownerDocument.defaultView;
	const computed: PickedMessage["computed"] = {};
	if (!view) return computed;
	const style = view.getComputedStyle(element);
	for (const name of PICK_COMPUTED_PROPERTIES) {
		const value = style.getPropertyValue(name);
		if (value) computed[name] = value.slice(0, PICK_COMPUTED_VALUE_MAX_CHARS);
	}
	return computed;
}

function tagOf(element: Element): string {
	const tag = element.localName.toLowerCase();
	return TAG_PATTERN.test(tag) && tag.length <= PICK_TAG_MAX_CHARS ? tag : "element";
}

/** Everything in a pick except the screenshot. */
export function capturePick(element: Element): PickedMessage {
	const html = trimHtml(element);
	const rules = matchingRules(element);
	const pathname = element.ownerDocument.defaultView?.location.pathname ?? "/";
	return {
		v: PICK_MESSAGE_VERSION,
		type: "picked",
		pagePath: pathname.slice(0, PICK_PAGE_PATH_MAX_CHARS),
		selector: uniqueSelector(element),
		tag: tagOf(element),
		html: html.html,
		rules: rules.rules,
		computed: computedValues(element),
		trimmed: { html: html.trimmed, rules: rules.trimmed },
	};
}
