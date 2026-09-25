/**
 * The settings window's one list of sections (issue #340, SPEC.md §13.5).
 * Search reads this list and nothing else, so a section added here is
 * searchable without a second index.
 */

/** A labelled control. The label is what search matches and what the pane shows. */
export interface SettingsControl {
	id: string;
	label: string;
}

/** Controls shown together under one heading inside a section. */
export interface SettingsGroup {
	title: string;
	controls: readonly SettingsControl[];
}

export interface SettingsSection {
	id: string;
	title: string;
	groups: readonly SettingsGroup[];
}

/** A search hit. `controlId` is null when the section title itself matched. */
export interface SettingsHit {
	sectionId: string;
	controlId: string | null;
	label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		id: "profile",
		title: "Profile",
		groups: [
			{
				title: "From your institution sign-in",
				controls: [
					{ id: "display-name", label: "Display name" },
					{ id: "email", label: "Email" },
					{ id: "sign-in-name", label: "Sign-in name" },
					{ id: "workspace-label", label: "Workspace label" },
				],
			},
			{
				title: "About you",
				controls: [
					{ id: "profile-picture", label: "Profile picture" },
					{ id: "github", label: "GitHub" },
					{ id: "website", label: "Personal site" },
				],
			},
			{
				title: "Linked accounts",
				controls: [{ id: "sso-link", label: "Link to my SSO account" }],
			},
		],
	},
	{
		id: "preferences",
		title: "Preferences",
		groups: [
			{
				title: "Editor",
				controls: [
					{ id: "auto-save", label: "Auto-save" },
					{ id: "auto-save-delay", label: "Auto-save delay in seconds" },
					{ id: "word-wrap", label: "Word wrap" },
				],
			},
			{
				title: "Terminal",
				controls: [{ id: "terminal-colours", label: "Terminal colors" }],
			},
			{
				title: "Accessibility",
				controls: [{ id: "screen-reader-mode", label: "Screen reader mode" }],
			},
			{
				title: "Workspace",
				controls: [{ id: "workspace-timezone", label: "Workspace timezone" }],
			},
			{
				title: "Appearance",
				controls: [{ id: "colour-scheme", label: "Color scheme" }],
			},
		],
	},
	// Only for a Dex local password; the dialog drops it for everyone else (docs/EPIC-14-2.md ruling 16).
	{
		id: "password",
		title: "Password",
		groups: [
			{
				title: "Change password",
				controls: [{ id: "change-password", label: "Change password" }],
			},
		],
	},
	// Help text only, no controls; search finds it by its title (issue #359).
	{
		id: "keyboard",
		title: "Keyboard and screen readers",
		groups: [],
	},
];

/**
 * Sections and controls whose title or label contains `query`. A blank query
 * matches nothing: the window shows the section list itself until someone
 * types. Matching is case-insensitive.
 */
export function settingsHits(
	sections: readonly SettingsSection[],
	query: string,
): SettingsHit[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [];
	const hits: SettingsHit[] = [];
	for (const section of sections) {
		if (section.title.toLowerCase().includes(needle)) {
			hits.push({ sectionId: section.id, controlId: null, label: section.title });
		}
		for (const group of section.groups) {
			for (const control of group.controls) {
				if (control.label.toLowerCase().includes(needle)) {
					hits.push({
						sectionId: section.id,
						controlId: control.id,
						label: control.label,
					});
				}
			}
		}
	}
	return hits;
}
