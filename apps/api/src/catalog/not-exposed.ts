import type { NotExposed } from "./types.js";

/**
 * Every route a key cannot run, with the reason (SPEC.md section 27). Keys are
 * `"METHOD url"` exactly as in `ROUTE_POLICY`. `never: true` marks the routes
 * no key may ever reach; `catalog.test.ts` pins that list.
 */

function group(
	keys: readonly string[],
	reason: string,
	never?: true,
): Record<string, NotExposed> {
	const entries: Record<string, NotExposed> = {};
	for (const key of keys) {
		entries[key] = never ? { reason, never } : { reason };
	}
	return entries;
}

const OWNER_WORKSPACE =
	"A person's own workspace, used in the browser; file contents and terminal bytes never go out";
const SIGN_IN_MACHINERY =
	"Sign-in machinery or a loopback or preview-edge route; there is no person to act as";
const WEBSOCKET = "A WebSocket; keys use plain requests only";
const SECRET_FIELDS = "Carries a secret field the key must never read or write";
const BROWSER_TRIAL =
	"A trial that needs the administrator's browser; a remote caller could lock the site out";
const OWN_PREFERENCES = "The holder's own preferences; the holder acts in person";
const ONE_TIME_PASSWORD = "The answer carries a one-time password";
const IMPERSONATION =
	"Impersonation: it binds one sign-in to another account, so it needs a person in a browser";

export const NOT_EXPOSED: Readonly<Record<string, NotExposed>> = {
	// The never list (docs/SPEC.md section 27).
	...group(
		["GET /admin/root-shell", "GET /admin/root-shell/ws"],
		"A root shell in a workspace",
		true,
	),
	...group(
		[
			"GET /me/second-factor",
			"POST /me/second-factor/totp/start",
			"POST /me/second-factor/totp",
			"POST /me/second-factor/verify",
			"POST /me/second-factor/webauthn/start",
			"POST /me/second-factor/webauthn",
			"POST /me/second-factor/webauthn/verify/start",
			"POST /me/second-factor/webauthn/verify",
			"POST /me/second-factor/recovery-codes",
			"PATCH /me/second-factor/:id",
			"DELETE /me/second-factor/:id",
			"POST /me/password",
			"POST /admin/dex-users/:id/reset-second-factor",
		],
		"A second factor or password change",
		true,
	),
	...group(
		[
			"GET /me/api-keys",
			"POST /me/api-keys",
			"POST /me/api-keys/passkey/start",
			"POST /me/api-keys/:id/renew",
			"POST /me/api-keys/:id/rotate",
			"POST /me/api-keys/:id/revoke",
			"GET /admin/api-keys",
			"POST /admin/api-keys/:id/expire",
			"POST /admin/api-keys/:id/revoke",
			"POST /admin/users/:id/api-keys/expire",
			"POST /admin/users/:id/api-keys/revoke",
			"POST /admin/api-keys/expire-all",
			"POST /admin/api-keys/revoke-all",
		],
		"Key management stays in a signed-in browser",
		true,
	),
	...group(
		[
			"GET /me/links",
			"GET /me/links/pending",
			"POST /me/links/start",
			"POST /me/links/passkey/start",
			"POST /me/links/confirm",
			"POST /me/links/:courseUserId/unlink",
			"POST /admin/users/:id/links",
			"DELETE /admin/users/:id/links/:courseUserId",
		],
		IMPERSONATION,
		true,
	),
	...group(
		["PATCH /admin/dex-users/:id"],
		"Changes where reset links go; with send-reset-link that is account takeover",
		true,
	),
	...group(
		[
			"POST /admin/dex-users",
			"POST /admin/dex-users/:id/reset-password",
			"POST /admin/accounts/import/preview",
			"POST /admin/accounts/import",
		],
		ONE_TIME_PASSWORD,
		true,
	),
	...group(
		[
			"PUT /admin/notifications",
			"POST /admin/signin",
			"POST /admin/certificate/jobs",
			"PUT /admin/docker/hub-credential",
			"DELETE /admin/docker/hub-credential",
			"POST /admin/backups/key",
			"POST /admin/backups/key/download",
		],
		SECRET_FIELDS,
		true,
	),
	...group(
		[
			"GET /admin/ai",
			"PUT /admin/ai",
			"POST /admin/ai/notice",
			"POST /admin/ai/test",
			"GET /admin/ai/models",
		],
		"The built-in AI's provider key and the notice an administrator reads in person; the key is write-only and never goes to a caller",
		true,
	),
	...group(
		[
			"GET /assistant/status",
			"POST /assistant/conversations",
			"GET /assistant/conversations",
			"DELETE /assistant/conversations/:id",
			"GET /assistant/conversations/:id/socket",
		],
		"The built-in assistant is used in a signed-in browser; it runs operations as that person's session, and a key already has MCP",
	),

	// Sign-in machinery, loopback and preview-edge routes.
	...group(
		[
			"GET /auth/login",
			"GET /auth/callback",
			"POST /auth/logout",
			"POST /auth/password-reset",
			"POST /auth/password-reset/complete",
			"GET /lti/login",
			"POST /lti/login",
			"POST /lti/launch",
			"POST /lti/deep-link",
			"GET /lti/jwks",
			"GET /health",
			"GET /edge/signin-throttle",
			"GET /edge/certificate-ask",
			"GET /.well-known/portikus-preflight/:nonce",
			"POST /dex/auth/*",
			"GET /__portikus/bootstrap",
			"GET /__portikus/reset",
			"GET /preview/authorize",
		],
		SIGN_IN_MACHINERY,
	),

	// WebSockets.
	...group(
		[
			"GET /workspaces/:id/ws",
			"GET /workspaces/:id/terminals/:tid/ws",
			"GET /workspaces/:id/terminals/:tid/chat",
			"GET /workspaces/:id/projects/:pid/events",
			"GET /workspaces/:id/projects/:pid/language-servers/:server",
			"GET /workspaces/:id/projects/:pid/checks/:checkId/runs/current",
			"GET /courses/:courseId/live-help/:sid/terminals/:tid/ws",
		],
		WEBSOCKET,
	),

	// Owner routes: a person's own workspace.
	...group(
		[
			"POST /workspaces",
			"PUT /workspaces/:id/keep-running",
			"DELETE /workspaces/:id/keep-running",
			"GET /workspaces/:id/usage",
			"GET /workspaces/:id/agent-meter",
			"GET /workspaces/:id/listening",
			"POST /workspaces/:id/listening/:port/stop",
			"POST /workspaces/:id/processes/:pid/stop",
			"POST /workspaces/:id/processes/:pid/stop-tree",
			"POST /workspaces/:id/processes/:pid/lower-priority",
			"POST /workspaces/:id/preview-grants",
			"GET /workspaces/:id/preview/embeddable",
			"POST /workspaces/:id/preview/reset",
			"GET /workspaces/:id/terminals",
			"POST /workspaces/:id/terminals",
			"PATCH /workspaces/:id/terminals/:tid",
			"DELETE /workspaces/:id/terminals/:tid",
			"POST /workspaces/:id/terminals/:tid/question",
			"GET /workspaces/:id/projects",
			"GET /workspaces/:id/projects/templates",
			"POST /workspaces/:id/projects",
			"POST /workspaces/:id/projects/starter",
			"PATCH /workspaces/:id/projects/:pid",
			"DELETE /workspaces/:id/projects/:pid",
			"POST /workspaces/:id/projects/:pid/duplicate",
			"POST /workspaces/:id/projects/:pid/git-init",
			"GET /workspaces/:id/projects/:pid/download",
			"GET /workspaces/:id/projects/:pid/layout",
			"PUT /workspaces/:id/projects/:pid/layout",
			"GET /workspaces/:id/projects/:pid/chat-settings",
			"PUT /workspaces/:id/projects/:pid/chat-settings",
			"GET /workspaces/:id/projects/:pid/share",
			"POST /workspaces/:id/projects/:pid/share",
			"POST /workspaces/:id/projects/:pid/share/stop",
			"GET /workspaces/:id/projects/:pid/tree",
			"GET /workspaces/:id/projects/:pid/file",
			"GET /workspaces/:id/projects/:pid/image",
			"PUT /workspaces/:id/projects/:pid/file",
			"DELETE /workspaces/:id/projects/:pid/file",
			"POST /workspaces/:id/projects/:pid/mkdir",
			"POST /workspaces/:id/projects/:pid/move",
			"POST /workspaces/:id/projects/:pid/extract",
			"GET /workspaces/:id/projects/:pid/extract/progress",
			"GET /workspaces/:id/projects/:pid/git/status",
			"GET /workspaces/:id/projects/:pid/git/diff",
			"GET /workspaces/:id/projects/:pid/baseline-status",
			"GET /workspaces/:id/projects/:pid/baseline-diff",
			"GET /workspaces/:id/projects/:pid/search",
			"POST /workspaces/:id/projects/:pid/file-search",
			"GET /workspaces/:id/projects/:pid/checks",
			"POST /workspaces/:id/projects/:pid/checks/:checkId/runs",
			"DELETE /workspaces/:id/projects/:pid/checks/:checkId/runs/current",
			"GET /workspaces/:id/projects/:pid/checks/:checkId/history",
			"GET /workspaces/:id/projects/:pid/checks/:checkId/history/:runId/output",
			"GET /workspaces/:id/projects/:pid/recovery-points",
			"POST /workspaces/:id/projects/:pid/recovery-points",
			"POST /workspaces/:id/projects/:pid/recovery-points/:rpid/restore",
			"GET /workspaces/:id/projects/:pid/recovery-points/:rpid/diff",
			"GET /workspaces/:id/projects/:pid/recovery-asides",
			"DELETE /workspaces/:id/projects/:pid/recovery-asides/:rpid",
			"GET /workspaces/:id/live-help",
			"POST /workspaces/:id/projects/:pid/live-help",
			"POST /workspaces/:id/live-help/typing",
			"POST /workspaces/:id/live-help/stop",
			"GET /workspaces/:id/reinstall-note",
			"POST /workspaces/:id/reinstall-note/dismiss",
		],
		OWNER_WORKSPACE,
	),

	// An instructor's view of a student's shared project.
	...group(
		[
			"GET /courses/:courseId/shares/:projectId/tree",
			"GET /courses/:courseId/shares/:projectId/file",
			"GET /courses/:courseId/shares/:projectId/git/status",
			"GET /courses/:courseId/shares/:projectId/git/diff",
		],
		"A student's project content",
	),
	...group(
		["POST /courses/:courseId/live-help/:sid/preview-grants"],
		"Creates a browser preview ticket",
	),

	// Administrator trials and downloads.
	...group(
		[
			"POST /admin/address/plan",
			"POST /admin/address/preflight",
			"POST /admin/address/apply",
			"POST /admin/address/keep",
			"POST /admin/address/rollback",
			"POST /admin/signin/keep",
			"POST /admin/signin/rollback",
			"POST /admin/signin/test",
		],
		BROWSER_TRIAL,
	),
	...group(
		["POST /admin/certificate/preflight"],
		"A step of a certificate change no key may make",
	),
	...group(["GET /admin/certificate/root.crt"], "A file download for a browser"),

	// The holder's own preferences.
	...group(
		[
			"GET /me/settings",
			"PUT /me/settings",
			"GET /me/profile",
			"PUT /me/profile",
			"GET /me/picture",
			"PUT /me/picture",
			"DELETE /me/picture",
			"GET /me/acceptable-use",
			"POST /me/acceptable-use",
			"POST /me/notifications",
			"DELETE /me/notifications",
			"PATCH /me/notifications/:id",
			"POST /me/notifications/read-all",
		],
		OWN_PREFERENCES,
	),

	// The doors themselves: any key may reach them, so the gate allows them
	// before it looks up an operation.
	...group(["GET /mcp", "POST /mcp"], "The MCP door; any key may reach it"),
	...group(["GET /openapi.json"], "The OpenAPI document; any key may reach it"),
};
