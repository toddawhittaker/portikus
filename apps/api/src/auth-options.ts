import type { AuthOptions } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";

/** Map the validated environment to the auth library's options. */
export function toAuthOptions(config: ApiConfig): AuthOptions {
	return {
		publicUrl: config.PUBLIC_URL,
		issuerUrl: config.OIDC_ISSUER_URL,
		clientId: config.OIDC_CLIENT_ID,
		clientSecret: config.OIDC_CLIENT_SECRET,
		scopes: config.OIDC_SCOPES,
		groupsClaim: config.OIDC_GROUPS_CLAIM,
		studentGroup: config.OIDC_STUDENT_GROUP,
		adminGroup: config.OIDC_ADMIN_GROUP,
		instructorGroup: config.OIDC_INSTRUCTOR_GROUP,
		cookieSecret: config.SESSION_COOKIE_SECRET,
		sessionTtlSeconds: config.SESSION_TTL_SECONDS,
		provider: config.OIDC_PROVIDER,
		allowedTenant: config.OIDC_ALLOWED_TENANT ?? null,
		allowedDomains: config.oidcAllowedDomains,
		defaultRole: config.OIDC_DEFAULT_ROLE,
		outboundProxyUrl: config.OUTBOUND_PROXY_URL ?? null,
	};
}
