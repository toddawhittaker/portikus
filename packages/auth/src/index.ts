/** OIDC login, server-side sessions, and authorization helpers (SPEC.md sections 5 and 24, STACK.md section 8). */

export {
	type CarryOverInput,
	type CarryOverOutcome,
	type CarryOverReport,
	type CarryOverUser,
	carryOver,
	formatReport,
	parseCarryOverInput,
} from "./carry-over.js";
export { dexLocalSubject } from "./dex-subject.js";
export {
	isOnOrigin,
	type LtiLoginParams,
	type LtiLoginRefusal,
	type LtiLoginResult,
	startLtiLogin,
} from "./lti/login.js";
export {
	findPlatform,
	type LtiPlatform,
	loadPlatformsFile,
	PlatformsFileError,
	parsePlatformsFile,
} from "./lti/platforms.js";
export { type LtiRole, mapLtiRoles } from "./lti/roles.js";
export {
	checkLaunchState,
	consumeLoginState,
	hashState,
	LTI_STATE_TTL_SECONDS,
	type LtiLoginState,
	type LtiLoginStatesTable,
	ltiStateCookieName,
	ltiStateCookieOptions,
	saveLoginState,
} from "./lti/state.js";
export {
	createKeySetSource,
	type KeySetSource,
	type LtiLaunch,
	type LtiLaunchResult,
	type LtiRefusal,
	type ValidateLaunchInput,
	validateLaunchToken,
} from "./lti/validate.js";
export {
	createOidcClient,
	type LoginState,
	type OidcClient,
	OidcError,
} from "./oidc.js";
export {
	type AuthPluginOptions,
	authPlugin,
	checkCsrf,
	checkWsOrigin,
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
	loadSession,
	type OidcIdentity,
	upsertUser,
} from "./sessions.js";
export {
	type AuthOptions,
	type AuthUser,
	LOGIN_COOKIE,
	mapRole,
	type Role,
	SESSION_COOKIE,
} from "./types.js";
