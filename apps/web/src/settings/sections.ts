/**
 * The settings window's one list of sections (SPEC.md §13.5).
 * Search reads this list and nothing else, so a section added here is
 * searchable without a second index.
 */

/** A labelled control. The label is what search matches and what the pane shows. */
export interface SettingsControl {
	id: string;
	label: string;
	/** Words search also matches that the short label leaves out, such as a unit. */
	terms?: string;
}

/** Controls shown together under one heading inside a section. */
interface SettingsGroup {
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
				title: "Appearance",
				controls: [{ id: "colour-scheme", label: "Color scheme" }],
			},
			{
				title: "Editor",
				controls: [
					{ id: "auto-save", label: "Auto-save" },
					{ id: "auto-save-delay", label: "Auto-save delay", terms: "seconds" },
					{ id: "word-wrap", label: "Word wrap" },
				],
			},
			{
				title: "Terminal",
				controls: [{ id: "terminal-colours", label: "Terminal colors" }],
			},
			{
				title: "Accessibility",
				controls: [
					{ id: "screen-reader-mode", label: "Screen reader mode" },
					// A pointer to Help, kept here so search still finds it.
					{ id: "keyboard-help", label: "Keyboard and screen readers" },
				],
			},
			{
				title: "Workspace",
				controls: [{ id: "workspace-timezone", label: "Workspace timezone" }],
			},
		],
	},
	// Only for a Dex local password; the dialog drops it for everyone else (SPEC.md section 5.3).
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
	// Only for a Dex local password, like Password (SPEC.md section 24.13).
	{
		id: "two-factor",
		title: "Two-factor sign-in",
		groups: [
			{
				title: "Two-factor sign-in",
				controls: [
					{
						id: "second-factors",
						label: "Your sign-in methods",
						terms: "two-step authenticator passkey security key",
					},
					{
						id: "add-second-factor",
						label: "Add a sign-in method",
						terms: "authenticator app passkey",
					},
					{ id: "recovery-codes", label: "Recovery codes" },
				],
			},
		],
	},
];

/**
 * Sections and controls whose title, label or search terms contain `query`. A blank query
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
				const text = `${control.label} ${control.terms ?? ""}`.toLowerCase();
				if (text.includes(needle)) {
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
