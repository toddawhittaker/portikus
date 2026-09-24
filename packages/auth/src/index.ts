/** OIDC login, server-side sessions, and authorization helpers (SPEC.md sections 5 and 24, STACK.md section 8). */

export {
	createDexApi,
	DEX_BCRYPT_COST,
	DEX_PASSWORD_LENGTH,
	type DexApi,
	type DexApiConnection,
	type DexApiEnv,
	type DexPassword,
	generateDexPassword,
	hashDexPassword,
	loadDexApi,
} from "./dex-api.js";
export { dexLocalSubject, dexLocalUserId } from "./dex-subject.js";
export {
	bindLinkIntent,
	consumeLinkIntent,
	courseLinkWindow,
	findLinkIntent,
	grantAdministrator,
	grantInstructor,
	isCourseIssuer,
	LINK_INTENT_TTL_SECONDS,
	LINK_WINDOW_SECONDS,
	type LinkIntent,
	type LinkRefusal,
	type LinkWindow,
	linkAccounts,
	listLinks,
	pendingLinkIntent,
	platformIssuerOf,
	type RoleChange,
	resolveIdentity,
	revokeAdministrator,
	revokeInstructor,
	saveLinkIntent,
	sessionLinkState,
	unlinkAccount,
} from "./links.js";
export { isOnOrigin, type LtiLoginParams, startLtiLogin } from "./lti/login.js";
export {
	type LtiPlatform,
	loadPlatformsFile,
	PlatformsFileError,
} from "./lti/platforms.js";
export {
	checkLaunchState,
	consumeLoginState,
	ltiStateCookieName,
	ltiStateCookieOptions,
	readLtiStateCookie,
	saveLoginState,
	staleLtiStateCookies,
} from "./lti/state.js";
export {
	createKeySetSource,
	type LtiLaunch,
	validateLaunchToken,
} from "./lti/validate.js";
export {
	type AdmissionRefusal,
	createOidcClient,
	type LoginState,
	type OidcClient,
	OidcError,
} from "./oidc.js";
export {
	authPlugin,
	loginCookieName,
	loginCookieOptions,
	requireRole,
	requireUser,
	sessionCookieName,
	sessionCookieOptions,
} from "./plugin.js";
export {
	createSession,
	deleteSession,
	hashSessionToken,
	loadSession,
	loadSessionById,
	type SessionMethod,
	type SessionOrigin,
	sessionOrigin,
	upsertUser,
} from "./sessions.js";
export { type AuthOptions, mapRole, type OidcProvider, type Role } from "./types.js";
