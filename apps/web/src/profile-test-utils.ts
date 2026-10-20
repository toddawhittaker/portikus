import { type CourseProfile, EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";

/** A `GET /me/settings` body for a student whose course profile is `courseProfile`. */
export function meSettingsBody(courseProfile: CourseProfile) {
	return {
		...EDITOR_SETTINGS_DEFAULTS,
		appearance: "system",
		appearanceStored: true,
		timezones: ["America/New_York"],
		codeHelpEnabled: true,
		courseProfile,
	};
}
