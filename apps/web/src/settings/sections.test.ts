/** Issue #340: search is the section list, not a second index. */
import { expect, test } from "vitest";
import { SETTINGS_SECTIONS, type SettingsSection, settingsHits } from "./sections.js";

const EXAMPLE: SettingsSection = {
	id: "example",
	title: "Example",
	groups: [
		{
			title: "Example",
			controls: [{ id: "example-switch", label: "Example switch" }],
		},
	],
};

test("a blank query does not invent hits", () => {
	expect(settingsHits(SETTINGS_SECTIONS, "   ")).toEqual([]);
});

test("a section added to the list is found by its title and its control labels", () => {
	const sections = [...SETTINGS_SECTIONS, EXAMPLE];

	expect(settingsHits(sections, "example switch")).toEqual([
		{
			sectionId: "example",
			controlId: "example-switch",
			label: "Example switch",
		},
	]);
	expect(settingsHits(sections, "Example")).toContainEqual({
		sectionId: "example",
		controlId: null,
		label: "Example",
	});
	// The same words are not hits until the section is on the list.
	expect(settingsHits(SETTINGS_SECTIONS, "example switch")).toEqual([]);
});

test("matching ignores case and can hit several controls in one section", () => {
	const hits = settingsHits(SETTINGS_SECTIONS, "color");
	expect(hits.map((hit) => hit.controlId)).toEqual([
		"colour-scheme",
		"terminal-colours",
	]);
});

test("search finds the SSO account link in Profile (docs/archive/epics/EPIC-13-1.md, flow step 1)", () => {
	expect(settingsHits(SETTINGS_SECTIONS, "sso")).toEqual([
		{ sectionId: "profile", controlId: "sso-link", label: "Link to my SSO account" },
	]);
});

test("Appearance comes first under Preferences, where students look for it", () => {
	const preferences = SETTINGS_SECTIONS.find((section) => section.id === "preferences");
	expect(preferences?.groups[0]?.title).toBe("Appearance");
});
