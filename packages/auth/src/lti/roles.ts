/** The platform role an LTI launch can grant; never administrator (docs/archive/epics/EPIC-13.md ruling 4). */
export type LtiRole = "student" | "instructor";

const LIS = "http://purl.imsglobal.org/vocab/lis/v2/";

/** Context (membership) roles that make someone teaching staff; a course admin counts. */
const STAFF = new Set([
	"Instructor",
	"TeachingAssistant",
	"ContentDeveloper",
	"Administrator",
]);

/** Principal roles whose sub-roles are still staff, e.g. membership/Instructor#TeachingAssistant. */
const STAFF_PRINCIPALS = new Set(["Instructor", "ContentDeveloper"]);

/** Bare short forms, which LTI 1.3 reads as context roles. */
const SHORT_FORMS = new Set(["Instructor", "TeachingAssistant", "ContentDeveloper"]);

function isInstructorRole(role: string): boolean {
	if (SHORT_FORMS.has(role)) return true;
	if (!role.startsWith(LIS)) return false;
	const rest = role.slice(LIS.length);
	if (rest.startsWith("membership#"))
		return STAFF.has(rest.slice("membership#".length));
	if (rest.startsWith("membership/")) {
		const principal = rest.slice("membership/".length).split("#")[0] ?? "";
		return STAFF_PRINCIPALS.has(principal);
	}
	// Institution #Instructor alone says nothing about this course; administrators do run it.
	return (
		rest === "institution/person#Administrator" ||
		rest === "system/person#Administrator"
	);
}

/** Map the LTI roles claim to a platform role; anything unrecognised is a student. */
export function mapLtiRoles(roles: unknown): LtiRole {
	if (!Array.isArray(roles)) return "student";
	for (const role of roles) {
		if (typeof role === "string" && isInstructorRole(role)) return "instructor";
	}
	return "student";
}
