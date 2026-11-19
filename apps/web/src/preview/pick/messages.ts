/**
 * The messages between the Portikus page and the preview wrapper page
 * (SPEC.md section 24, and BROWSER-HANDLING.md for the wrapper).
 *
 * The wrapper runs on the preview origin next to the student's code, so the
 * Portikus page treats everything the wrapper sends as untrusted input. The
 * limits below are enforced here, in the schema, and not left to the
 * wrapper's own trimming. The wrapper imports the same constants to trim to
 * them. Origin and source checks are not done here; the page that receives a
 * message makes them before it calls a parse function.
 */
import { MAX_CHAT_IMAGE_BYTES } from "@portikus/contracts";
import { z } from "zod";

export const PICK_MESSAGE_VERSION = 1;

/** The most outer HTML the wrapper may send, not counting the marker. */
export const PICK_HTML_MAX_CHARS = 20_000;
/** Appended to HTML that was cut short. */
export const PICK_HTML_TRIMMED_MARKER = "<!-- trimmed -->";
export const PICK_RULES_MAX_COUNT = 50;
/** Total characters of selector, declarations, media and address in all rules. */
export const PICK_RULES_MAX_CHARS = 20_000;
export const PICK_SELECTOR_MAX_CHARS = 1_000;
export const PICK_TAG_MAX_CHARS = 64;
export const PICK_COMPUTED_VALUE_MAX_CHARS = 200;
export const PICK_HOVER_LABEL_MAX_CHARS = 200;
export const PICK_MEDIA_MAX_CHARS = 500;
export const PICK_SHEET_ADDRESS_MAX_CHARS = 2_048;
export const PICK_PAGE_PATH_MAX_CHARS = 2_048;
/**
 * The picture's size limit. The schema does not apply it: an over-size
 * picture must drop only the picture, so the Portikus page checks it.
 */
export const PICK_PNG_MAX_BYTES = MAX_CHAT_IMAGE_BYTES;
/** A lower-case HTML or custom element name. */
export const PICK_TAG_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The only computed style properties a pick may carry. */
export const PICK_COMPUTED_PROPERTIES = [
	"display",
	"position",
	"width",
	"height",
	"margin",
	"padding",
	"border",
	"border-radius",
	"box-sizing",
	"color",
	"background-color",
	"background-image",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"line-height",
	"text-align",
	"text-decoration",
	"opacity",
	"overflow",
	"z-index",
	"flex-direction",
	"justify-content",
	"align-items",
	"gap",
	"grid-template-columns",
	"grid-template-rows",
	"float",
	"visibility",
] as const;

const computedProperty = z.enum(PICK_COMPUTED_PROPERTIES);

const version = z.literal(PICK_MESSAGE_VERSION);

const cssRule = z.strictObject({
	kind: z.literal("rule"),
	selector: z.string().max(PICK_SELECTOR_MAX_CHARS),
	declarations: z.string().max(PICK_RULES_MAX_CHARS),
	media: z.string().max(PICK_MEDIA_MAX_CHARS).optional(),
	sheet: z.string().max(PICK_SHEET_ADDRESS_MAX_CHARS).optional(),
});

/** A stylesheet from another origin, whose rules the page may not read. */
const unreadableSheet = z.strictObject({
	kind: z.literal("unreadable"),
	sheet: z.string().max(PICK_SHEET_ADDRESS_MAX_CHARS).optional(),
});

export type PickRule = z.infer<typeof cssRule> | z.infer<typeof unreadableSheet>;

export function ruleChars(rule: PickRule): number {
	return rule.kind === "unreadable"
		? (rule.sheet?.length ?? 0)
		: rule.selector.length +
				rule.declarations.length +
				(rule.media?.length ?? 0) +
				(rule.sheet?.length ?? 0);
}

export const PickedMessage = z.strictObject({
	v: version,
	type: z.literal("picked"),
	pagePath: z.string().max(PICK_PAGE_PATH_MAX_CHARS),
	selector: z.string().max(PICK_SELECTOR_MAX_CHARS),
	tag: z.string().max(PICK_TAG_MAX_CHARS).regex(PICK_TAG_PATTERN),
	html: z.string().max(PICK_HTML_MAX_CHARS + PICK_HTML_TRIMMED_MARKER.length),
	rules: z
		.array(z.union([cssRule, unreadableSheet]))
		.max(PICK_RULES_MAX_COUNT)
		.refine(
			(rules) =>
				rules.reduce((sum, rule) => sum + ruleChars(rule), 0) <= PICK_RULES_MAX_CHARS,
			{
				message: "rule text is too long",
			},
		),
	computed: z.partialRecord(
		computedProperty,
		z.string().max(PICK_COMPUTED_VALUE_MAX_CHARS),
	),
	trimmed: z.strictObject({ html: z.boolean(), rules: z.boolean() }),
	png: z.instanceof(ArrayBuffer).optional(),
});
export type PickedMessage = z.infer<typeof PickedMessage>;

const StartMessage = z.strictObject({ v: version, type: z.literal("start") });
const StopMessage = z.strictObject({ v: version, type: z.literal("stop") });
const HoverMessage = z.strictObject({
	v: version,
	type: z.literal("hover"),
	label: z.string().max(PICK_HOVER_LABEL_MAX_CHARS),
});
const CancelledMessage = z.strictObject({
	v: version,
	type: z.literal("cancelled"),
	/** The wrapper gave the keyboard back to the app element that had it. */
	focusInApp: z.boolean().optional(),
});

export const ParentMessage = z.discriminatedUnion("type", [StartMessage, StopMessage]);
export type ParentMessage = z.infer<typeof ParentMessage>;

export const WrapperMessage = z.discriminatedUnion("type", [
	HoverMessage,
	CancelledMessage,
	PickedMessage,
]);
export type WrapperMessage = z.infer<typeof WrapperMessage>;

/** The wrapper's message, or null for anything that does not fit. Never throws. */
export function parseWrapperMessage(data: unknown): WrapperMessage | null {
	return parseWith(WrapperMessage, data);
}

/** The Portikus page's message, or null for anything that does not fit. Never throws. */
export function parseParentMessage(data: unknown): ParentMessage | null {
	return parseWith(ParentMessage, data);
}

// A hostile object can throw from a getter, so the try/catch is part of "never throws".
function parseWith<T>(schema: z.ZodType<T>, data: unknown): T | null {
	try {
		const result = schema.safeParse(data);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
