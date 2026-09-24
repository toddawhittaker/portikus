import type { AdminImageVersion, AdminUser } from "@portikus/contracts";

type AccountMarkers = AdminUser["markers"];

const MARKER_LABEL: Record<keyof AccountMarkers, string> = {
	disabled: "Disabled",
	archived: "Archived",
	linked: "Linked",
	duplicateEmail: "Duplicate email",
	stale: "Stale",
};

const MARKER_ORDER: (keyof AccountMarkers)[] = [
	"disabled",
	"archived",
	"linked",
	"duplicateEmail",
	"stale",
];

/** The marker labels an account carries, in a fixed order (issue #302, EPIC-13-1 ruling 24). */
export function markerLabels(markers: AccountMarkers | undefined): string[] {
	if (!markers) return [];
	return MARKER_ORDER.filter((key) => markers[key]).map((key) => MARKER_LABEL[key]);
}

/** The tags beside a name in the Workspaces table. */
export function Markers({ markers }: { markers: AccountMarkers | undefined }) {
	const labels = markerLabels(markers);
	if (labels.length === 0) return null;
	return (
		<span className="ml-2 inline-flex gap-1">
			{labels.map((label) => (
				<span
					key={label}
					className={label === "Disabled" ? "pk-tag" : "pk-tag pk-tag--warning"}
				>
					{label}
				</span>
			))}
		</span>
	);
}

/** "2026.09.9 · current", or the fingerprint prefix when there is no serial. */
export function imageText(image: AdminImageVersion): string {
	const label = image.label ?? "Unknown";
	if (image.current === null) return label;
	return `${label} · ${image.current ? "current" : "older"}`;
}

const LTI_PREFIX = "lti:";

/** True for a course account, made by an LTI launch (EPIC-13 ruling 12). */
export function isCourseAccount(issuer: string | null | undefined): boolean {
	return issuer?.startsWith(LTI_PREFIX) ?? false;
}

/** "SSO", or "Course: <platform host>" for a course account (EPIC-13-1 ruling 24). */
export function sourceText(issuer: string | null | undefined): string {
	if (!issuer || !isCourseAccount(issuer)) return "SSO";
	return `Course: ${shortIssuer(issuer.slice(LTI_PREFIX.length))}`;
}

export const ROLE_FILTERS = ["administrator", "instructor", "student"] as const;

/** The Role column: an administrator says where the role came from (EPIC-13-1 ruling 24). */
export function roleText(user: Pick<AdminUser, "role" | "grantedRole">): string {
	if (user.role === "administrator") {
		return user.grantedRole === "administrator"
			? "Administrator (granted)"
			: "Administrator (from SSO)";
	}
	return user.role === "instructor" ? "Instructor" : "Student";
}

/** The first part of an issuer URL, for a narrow column. The full value goes in the title. */
export function shortIssuer(issuer: string | null | undefined): string {
	if (!issuer) return "—";
	try {
		return new URL(issuer).host;
	} catch {
		return issuer.length > 24 ? `${issuer.slice(0, 24)}…` : issuer;
	}
}

/**
 * Sorted by name, with every account that shares an email placed straight
 * after the first of them, so duplicates sit together (issue #302).
 */
export function sortAccounts(users: AdminUser[]): AdminUser[] {
	const byName = [...users].sort((a, b) => a.displayName.localeCompare(b.displayName));
	const placed = new Set<string>();
	const sorted: AdminUser[] = [];
	for (const user of byName) {
		if (placed.has(user.id)) continue;
		const email = user.email?.toLowerCase();
		const group =
			user.markers?.duplicateEmail && email
				? byName.filter((other) => other.email?.toLowerCase() === email)
				: [user];
		for (const member of group) {
			placed.add(member.id);
			sorted.push(member);
		}
	}
	return sorted;
}
