/** OIDC login, server-side sessions, and authorization helpers (SPEC.md sections 5 and 24, STACK.md section 8). */

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
	loadSession,
	upsertUser,
} from "./sessions.js";
export { type AuthOptions, mapRole, type Role } from "./types.js";
