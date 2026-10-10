/** OIDC login, server-side sessions, and authorization helpers (SPEC.md sections 5 and 24, STACK.md section 8). */

export {
	BREACHED_PASSWORD_MESSAGE,
	isBreachedPassword,
} from "./breached-passwords.js";
export {
	createDexApi,
	DEX_PASSWORD_LENGTH,
	type DexApi,
	type DexPassword,
	generateDexPassword,
	hashDexPassword,
	loadDexApi,
} from "./dex-api.js";
export {
	dexConnectorId,
	dexLocalSubject,
	dexLocalUserId,
	dexSubject,
	localDexUserId,
} from "./dex-subject.js";
export {
	bindLinkIntent,
	consumeLinkIntent,
	courseLinkWindow,
	findLinkIntent,
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
	precreateDexAccount,
	resolveIdentity,
	saveLinkIntent,
	sessionLinkState,
	unlinkAccount,
} from "./links.js";
export {
	LOCAL_ADMIN_USER_ID,
	LocalAdminEmailTaken,
	resetLocalAdmin,
	runResetAdmin,
} from "./local-admin.js";
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
	type AuthenticationResponseJSON,
	type ChallengeStore,
	checkPasskey,
	createChallengeStore,
	listPasskeys,
	passkeyAuthenticationOptions,
	passkeyRegistrationOptions,
	type RegistrationResponseJSON,
	type RelyingParty,
	relyingParty,
	verifyPasskeyRegistration,
} from "./passkey.js";
export {
	authPlugin,
	connectorCookieName,
	connectorCookieOptions,
	DEX_PASSWORD_ROUTE,
	loginCookieName,
	loginCookieOptions,
	requireRole,
	requireUser,
	sessionCookieName,
	sessionCookieOptions,
	sessionGate,
} from "./plugin.js";
export {
	grantAdministrator,
	grantInstructor,
	type RoleChange,
	revokeAdministrator,
	revokeInstructor,
} from "./roles.js";
export {
	accountNeedsSecondFactor,
	checkSecondFactor,
	enrolTotp,
	isRecoveryCodeShape,
	markSecondFactorPassed,
	openPendingTotp,
	replaceRecoveryCodes,
	resetSecondFactor,
	sealPendingTotp,
	secondFactorApplies,
	secondFactorKey,
	storeFactor,
	useRecoveryCode,
} from "./second-factor.js";
export {
	createSession,
	deleteSession,
	ELEVATED_SESSION_MAX_SECONDS,
	hashSessionToken,
	loadSession,
	loadSessionById,
	roleFromProvider,
	type SessionMethod,
	type SessionOrigin,
	sessionOrigin,
	upsertUser,
} from "./sessions.js";
export { base32Encode, generateTotpSecret, matchTotp, otpauthUri } from "./totp.js";
export { type AuthOptions, mapRole, type Role } from "./types.js";
