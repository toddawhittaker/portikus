/**
 * Monaco's own token colours below 4.5:1 on our editor and line-highlight
 * backgrounds (SPEC.md section 25.8), each moved in lightness only, so the
 * hue a student knows stays the same.
 */
export const LIGHT_TOKENS: Record<string, string> = {
	invalid: "c52f2f",
	constant: "d50000",
	comment: "007b00",
	number: "08784f",
	annotation: "696969",
	type: "007373",
	"tag.id.pug": "476a9b",
	"tag.class.pug": "476a9b",
	metatag: "d30000",
	"metatag.content.html": "d40000",
	"metatag.html": "696969",
	"metatag.xml": "696969",
	"attribute.name": "d40000",
	"attribute.value.number": "08784f",
	"attribute.value.unit": "08784f",
	"string.sql": "d40000",
	"operator.sql": "5b6b7a",
	"predefined.sql": "ba00ba",
};

export const DARK_TOKENS: Record<string, string> = {
	"variable.predefined": "7087c2",
	comment: "679553",
	regexp: "ba729d",
	annotation: "ce6c6c",
	"delimiter.html": "888888",
	"delimiter.xml": "888888",
	"tag.id.pug": "688aba",
	"tag.class.pug": "688aba",
	"string.sql": "ff3b3b",
};
