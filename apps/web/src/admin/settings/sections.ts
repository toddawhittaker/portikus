/** The Settings tab's sections, in page order; each id is its heading's, which the index links to. */
export const SECTIONS = {
	stop: { id: "settings-stop", title: "When workspaces stop" },
	guard: { id: "settings-guard", title: "Resource guard" },
	tools: { id: "settings-tools", title: "Student tools" },
	aup: { id: "settings-aup", title: "Acceptable use" },
	mail: { id: "settings-mail", title: "Email and alerts" },
} as const;

export type SettingsSection = (typeof SECTIONS)[keyof typeof SECTIONS];
