/** The platform role an LTI launch can grant; never administrator (docs/EPIC-13.md ruling 4). */
export type LtiRole = "student" | "instructor";

const INSTRUCTOR_ROLES = new Set([
	"Instructor",
	"TeachingAssistant",
	"ContentDeveloper",
	"Administrator",
]);

/** The part after the last `#` or `/`, so full and short role URIs match alike. */
function lastSegment(uri: string): string {
	const hash = uri.lastIndexOf("#");
	if (hash >= 0) return uri.slice(hash + 1);
	return uri.slice(uri.lastIndexOf("/") + 1);
}

/** Map the LTI roles claim to a platform role; anything unrecognised is a student. */
export function mapLtiRoles(roles: unknown): LtiRole {
	if (!Array.isArray(roles)) return "student";
	for (const role of roles) {
		if (typeof role === "string" && INSTRUCTOR_ROLES.has(lastSegment(role))) {
			return "instructor";
		}
	}
	return "student";
}
