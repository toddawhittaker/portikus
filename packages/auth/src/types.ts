/** Platform roles (SPEC.md section 5.2). */
export type Role = "student" | "instructor" | "administrator";

export interface AuthUser {
	id: string;
	email: string | null;
	displayName: string;
	role: Role;
}

/** Everything the auth helpers need, validated by the service's config loader. */
export interface AuthOptions {
	publicUrl: string;
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	groupsClaim: string;
	studentGroup: string;
	adminGroup: string;
	/** OIDC_INSTRUCTOR_GROUP (docs/archive/epics/EPIC-13.md ruling 4). */
	instructorGroup: string;
	cookieSecret: string;
	sessionTtlSeconds: number;
	/** OIDC_PROVIDER (docs/archive/epics/EPIC-14.md); absent means generic OIDC. */
	provider?: OidcProvider;
	/** OIDC_ALLOWED_TENANT: the one Entra tenant ID (ruling 8). */
	allowedTenant?: string | null;
	/** OIDC_ALLOWED_DOMAINS, lowercased: the Google `hd` values (ruling 3). */
	allowedDomains?: readonly string[];
	/** OIDC_DEFAULT_ROLE: the role when no group matches (ruling 11); absent means none. */
	defaultRole?: "none" | "student";
	/** OUTBOUND_PROXY_URL (ruling 27); absent means direct. */
	outboundProxyUrl?: string | null;
}

export type OidcProvider = "oidc" | "entra" | "google";

export const SESSION_COOKIE = "portikus_session";
export const LOGIN_COOKIE = "portikus_login";

/**
 * Map the identity provider's group claim to a platform role; the highest
 * role wins. With none of the groups the answer is OIDC_DEFAULT_ROLE:
 * null (refused) or student (docs/archive/epics/EPIC-14.md ruling 11).
 */
export function mapRole(
	claims: Record<string, unknown>,
	opts: AuthOptions,
): Role | null {
	// An empty claim name means the site takes no roles from the token.
	const raw = opts.groupsClaim === "" ? undefined : claims[opts.groupsClaim];
	const groups =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((g): g is string => typeof g === "string")
				: [];

	if (groups.includes(opts.adminGroup)) {
		return "administrator";
	}
	if (groups.includes(opts.instructorGroup)) {
		return "instructor";
	}
	if (groups.includes(opts.studentGroup)) {
		return "student";
	}
	return opts.defaultRole === "student" ? "student" : null;
}
