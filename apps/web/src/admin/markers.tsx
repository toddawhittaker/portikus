import type {
	AdminImageVersion,
	AdminUser,
	AdminWorkspaceSummary,
} from "@portikus/contracts";

type AccountMarkers = AdminUser["markers"];

const MARKER_LABEL: Record<keyof AccountMarkers, string> = {
	disabled: "Disabled",
	archived: "Archived",
	linked: "Linked",
	duplicateEmail: "Duplicate email",
	stale: "Stale",
	notSignedInYet: "Not signed in yet",
};

const MARKER_ORDER: (keyof AccountMarkers)[] = [
	"disabled",
	"archived",
	"linked",
	"duplicateEmail",
	"stale",
	"notSignedInYet",
];

// Plain tags: facts, not warnings. Keyed on the marker so a label rename keeps its style.
const NEUTRAL_KEYS: (keyof AccountMarkers)[] = ["disabled", "notSignedInYet"];
const NEUTRAL = new Set(NEUTRAL_KEYS.map((key) => MARKER_LABEL[key]));

type GuardState = Pick<AdminWorkspaceSummary, "cpuThrottle" | "memoryFlag">;

/**
 * The marker labels an account carries, in a fixed order (ADR 0026),
 * then its workspace's resource guard tags (ADR 0032).
 */
export function markerLabels(
	markers: AccountMarkers | undefined,
	workspace?: GuardState | null,
): string[] {
	const labels = markers
		? MARKER_ORDER.filter((key) => markers[key]).map((key) => MARKER_LABEL[key])
		: [];
	if (workspace?.cpuThrottle) labels.push("Throttled");
	// A throttle a restart does not lift (SPEC.md §19.4).
	if (workspace?.cpuThrottle?.held) labels.push("Held");
	if (workspace?.memoryFlag) labels.push("High memory");
	return labels;
}

/** The tags under a name in the Users table. The parent spaces them from the name. */
export function Markers({
	markers,
	workspace,
}: {
	markers: AccountMarkers | undefined;
	workspace?: GuardState | null;
}) {
	const labels = markerLabels(markers, workspace);
	if (labels.length === 0) return null;
	return (
		<span className="flex flex-wrap gap-1">
			{labels.map((label) => (
				<span
					key={label}
					className={NEUTRAL.has(label) ? "pk-tag" : "pk-tag pk-tag--warning"}
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

/** True for a course account, made by an LTI launch (ADR 0025). */
export function isCourseAccount(issuer: string | null | undefined): boolean {
	return issuer?.startsWith(LTI_PREFIX) ?? false;
}

/** "SSO", or "Course: <platform host>" for a course account (ADR 0026). */
export function sourceText(issuer: string | null | undefined): string {
	if (!issuer || !isCourseAccount(issuer)) return "SSO";
	return `Course: ${shortIssuer(issuer.slice(LTI_PREFIX.length))}`;
}

export const ROLE_FILTERS = ["administrator", "instructor", "student"] as const;

/** The Role column: an administrator says where the role came from (ADR 0026). */
export function roleText(user: Pick<AdminUser, "role" | "grantedRole">): string {
	if (user.role === "administrator") {
		return user.grantedRole === "administrator"
			? "Administrator (granted)"
			: "Administrator (from SSO)";
	}
	if (user.role === "instructor") {
		return user.grantedRole === "instructor" ? "Instructor (granted)" : "Instructor";
	}
	return "Student";
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
