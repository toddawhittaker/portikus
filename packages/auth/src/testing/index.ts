/** Test and development helpers: the in-repo mock identity provider and API test glue (ADR 0008). */
export {
	CookieJar,
	csrfHeaders,
	loginAs,
	type OpenSocket,
	openWorkspaceSocket,
} from "./helpers.js";
export {
	MOCK_CLIENT_ID,
	MOCK_CLIENT_SECRET,
	MOCK_GROUPS,
	MOCK_USERS,
	type MockOidcOptions,
	type MockOidcProvider,
	type MockUser,
	startMockOidcProvider,
} from "./mock-oidc.js";
