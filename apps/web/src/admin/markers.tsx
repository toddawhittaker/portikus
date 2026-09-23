import type {
	AdminAccountMarkers,
	AdminImageVersion,
	AdminUser,
} from "@portikus/contracts";

const MARKER_LABEL: Record<keyof AdminAccountMarkers, string> = {
	disabled: "Disabled",
	archived: "Archived",
	duplicateEmail: "Duplicate email",
	stale: "Stale",
};

const MARKER_ORDER: (keyof AdminAccountMarkers)[] = [
	"disabled",
	"archived",
	"duplicateEmail",
	"stale",
];

/** The marker labels an account carries, in a fixed order (issue #302). */
export function markerLabels(markers: AdminAccountMarkers | undefined): string[] {
	if (!markers) return [];
	return MARKER_ORDER.filter((key) => markers[key]).map((key) => MARKER_LABEL[key]);
}

/** The tags beside a name in the Workspaces table. */
export function Markers({ markers }: { markers: AdminAccountMarkers | undefined }) {
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
