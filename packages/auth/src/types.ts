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
	/** OIDC_INSTRUCTOR_GROUP; "instructor" when unset (docs/EPIC-13.md ruling 4). */
	instructorGroup?: string;
	cookieSecret: string;
	sessionTtlSeconds: number;
}

export const SESSION_COOKIE = "portikus_session";
export const LOGIN_COOKIE = "portikus_login";

/**
 * Map the identity provider's group claim to a platform role. Returns
 * null when the user is in none of the groups; the highest role wins.
 */
export function mapRole(
	claims: Record<string, unknown>,
	opts: AuthOptions,
): Role | null {
	const raw = claims[opts.groupsClaim];
	const groups =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((g): g is string => typeof g === "string")
				: [];

	if (groups.includes(opts.adminGroup)) {
		return "administrator";
	}
	if (groups.includes(opts.instructorGroup ?? "instructor")) {
		return "instructor";
	}
	if (groups.includes(opts.studentGroup)) {
		return "student";
	}
	return null;
}
