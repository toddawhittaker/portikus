/**
 * The access class of every route the API registers (Epic 12a, "The matrix";
 * SPEC.md sections 5, 20.2, and 24). It lives on the test side, so a route
 * cannot opt out of a check it cannot see. `authz-matrix.test.ts` fails when
 * a registered route is missing here, or when an entry here names a route
 * that no longer exists.
 *
 * Keys are `"<METHOD> <url pattern>"`, exactly as Fastify registers them,
 * including the automatic HEAD twin of every GET.
 */

export type AccessClass =
	/** Anyone, signed in or not. */
	| "public"
	/** Any signed-in user, acting only on their own account. */
	| "self"
	/** Only the workspace's owner; everyone else gets 404. */
	| "owner"
	/** The owner or an administrator; other students get 404. */
	| "owner-or-admin"
	/** Administrators only; students and instructors get 403. */
	| "admin"
	/** A course's instructors; everyone else sees no course, or a 404. */
	| "course-instructor"
	/** Preview host paths: only a preview session counts, never a main cookie. */
	| "preview-edge"
	/** The old preview placeholder: 401 signed out, 501 signed in. */
	| "inert";

export interface RoutePolicy {
	access: AccessClass;
	/** A browser socket; `ws-authz-matrix.test.ts` probes its upgrade. */
	websocket?: boolean;
}

const owner: RoutePolicy = { access: "owner" };
const ownerSocket: RoutePolicy = { access: "owner", websocket: true };

export const ROUTE_POLICY: Record<string, RoutePolicy> = {
	"GET /health": { access: "public" },
	// Only the GET is exempt from sign-in; hardening.test.ts pins that.
	"HEAD /health": { access: "self" },
	"GET /auth/login": { access: "public" },
	"HEAD /auth/login": { access: "public" },
	"GET /auth/callback": { access: "public" },
	"HEAD /auth/callback": { access: "public" },
	// Every /auth/ route is exempt; signing out with no session is a harmless
	// redirect, and the CSRF check still applies.
	"POST /auth/logout": { access: "public" },
	// Loopback only; Caddy asks it before Dex's password form (issue #398).
	"GET /edge/signin-throttle": { access: "public" },
	"HEAD /edge/signin-throttle": { access: "public" },

	// LTI 1.3 login and launch; the two POSTs are CSRF-exempt (docs/EPIC-13.md
	// ruling 7). With no platforms file every one answers 404.
	"GET /lti/login": { access: "public" },
	"HEAD /lti/login": { access: "public" },
	"POST /lti/login": { access: "public" },
	"POST /lti/launch": { access: "public" },
	"GET /lti/jwks": { access: "public" },
	"HEAD /lti/jwks": { access: "public" },

	"GET /auth/me": { access: "self" },
	"HEAD /auth/me": { access: "self" },
	"GET /me/settings": { access: "self" },
	"HEAD /me/settings": { access: "self" },
	"PUT /me/settings": { access: "self" },
	"GET /me/profile": { access: "self" },
	"HEAD /me/profile": { access: "self" },
	"PUT /me/profile": { access: "self" },
	"GET /me/picture": { access: "self" },
	"HEAD /me/picture": { access: "self" },
	"PUT /me/picture": { access: "self" },
	"DELETE /me/picture": { access: "self" },
	"POST /workspaces": { access: "self" },
	// Account linking (docs/EPIC-13-1.md, "The flow"); each checks its own state.
	"GET /me/links": { access: "self" },
	"HEAD /me/links": { access: "self" },
	"POST /me/links/start": { access: "self" },
	"GET /me/links/pending": { access: "self" },
	"HEAD /me/links/pending": { access: "self" },
	"POST /me/links/confirm": { access: "self" },
	"POST /me/links/:courseUserId/unlink": { access: "self" },

	"GET /workspaces/:id": { access: "owner-or-admin" },
	"HEAD /workspaces/:id": { access: "owner-or-admin" },
	"POST /workspaces/:id/start": { access: "owner-or-admin" },
	"POST /workspaces/:id/stop": { access: "owner-or-admin" },
	"POST /workspaces/:id/restart": { access: "owner-or-admin" },
	"GET /workspaces/:id/ws": { access: "owner-or-admin", websocket: true },

	"GET /workspaces/:id/usage": owner,
	"HEAD /workspaces/:id/usage": owner,
	"GET /workspaces/:id/listening": owner,
	"HEAD /workspaces/:id/listening": owner,
	"POST /workspaces/:id/listening/:port/stop": owner,
	"POST /workspaces/:id/preview-grants": owner,
	"GET /workspaces/:id/preview/embeddable": owner,
	"HEAD /workspaces/:id/preview/embeddable": owner,
	"POST /workspaces/:id/preview/reset": owner,

	"GET /workspaces/:id/terminals": owner,
	"HEAD /workspaces/:id/terminals": owner,
	"POST /workspaces/:id/terminals": owner,
	"PATCH /workspaces/:id/terminals/:tid": owner,
	"DELETE /workspaces/:id/terminals/:tid": owner,
	"GET /workspaces/:id/terminals/:tid/ws": ownerSocket,

	"GET /workspaces/:id/projects": owner,
	"HEAD /workspaces/:id/projects": owner,
	"GET /workspaces/:id/projects/templates": owner,
	"HEAD /workspaces/:id/projects/templates": owner,
	"POST /workspaces/:id/projects": owner,
	"PATCH /workspaces/:id/projects/:pid": owner,
	"DELETE /workspaces/:id/projects/:pid": owner,
	"POST /workspaces/:id/projects/:pid/duplicate": owner,
	"POST /workspaces/:id/projects/:pid/git-init": owner,
	"GET /workspaces/:id/projects/:pid/download": owner,
	"HEAD /workspaces/:id/projects/:pid/download": owner,
	"GET /workspaces/:id/projects/:pid/layout": owner,
	"HEAD /workspaces/:id/projects/:pid/layout": owner,
	"PUT /workspaces/:id/projects/:pid/layout": owner,
	"GET /workspaces/:id/projects/:pid/events": ownerSocket,

	"GET /workspaces/:id/projects/:pid/tree": owner,
	"HEAD /workspaces/:id/projects/:pid/tree": owner,
	"GET /workspaces/:id/projects/:pid/file": owner,
	"HEAD /workspaces/:id/projects/:pid/file": owner,
	"PUT /workspaces/:id/projects/:pid/file": owner,
	"DELETE /workspaces/:id/projects/:pid/file": owner,
	"POST /workspaces/:id/projects/:pid/mkdir": owner,
	"POST /workspaces/:id/projects/:pid/move": owner,

	"GET /workspaces/:id/projects/:pid/git/status": owner,
	"HEAD /workspaces/:id/projects/:pid/git/status": owner,
	"GET /workspaces/:id/projects/:pid/git/diff": owner,
	"HEAD /workspaces/:id/projects/:pid/git/diff": owner,
	"GET /workspaces/:id/projects/:pid/baseline-status": owner,
	"HEAD /workspaces/:id/projects/:pid/baseline-status": owner,
	"GET /workspaces/:id/projects/:pid/baseline-diff": owner,
	"HEAD /workspaces/:id/projects/:pid/baseline-diff": owner,
	"GET /workspaces/:id/projects/:pid/search": owner,
	"HEAD /workspaces/:id/projects/:pid/search": owner,

	"GET /workspaces/:id/projects/:pid/checks": owner,
	"HEAD /workspaces/:id/projects/:pid/checks": owner,
	"POST /workspaces/:id/projects/:pid/checks/:checkId/runs": owner,
	"DELETE /workspaces/:id/projects/:pid/checks/:checkId/runs/current": owner,
	"GET /workspaces/:id/projects/:pid/checks/:checkId/runs/current": ownerSocket,

	"GET /workspaces/:id/projects/:pid/recovery-points": owner,
	"HEAD /workspaces/:id/projects/:pid/recovery-points": owner,
	"POST /workspaces/:id/projects/:pid/recovery-points": owner,
	"POST /workspaces/:id/projects/:pid/recovery-points/:rpid/restore": owner,
	"POST /workspaces/:id/reset-docker": { access: "owner-or-admin" },

	"GET /courses": { access: "course-instructor" },
	"HEAD /courses": { access: "course-instructor" },
	"GET /courses/:courseId/members": { access: "course-instructor" },
	"HEAD /courses/:courseId/members": { access: "course-instructor" },
	"POST /courses/:courseId/members/:userId/remove": { access: "course-instructor" },

	"GET /admin/workspaces": { access: "admin" },
	"HEAD /admin/workspaces": { access: "admin" },
	"GET /admin/settings": { access: "admin" },
	"HEAD /admin/settings": { access: "admin" },
	"PUT /admin/settings": { access: "admin" },
	"GET /admin/users": { access: "admin" },
	"HEAD /admin/users": { access: "admin" },
	"PUT /admin/users/:id/settings": { access: "admin" },
	"POST /admin/users/:id/disable": { access: "admin" },
	"POST /admin/users/:id/enable": { access: "admin" },
	"POST /admin/users/:id/promote": { access: "admin" },
	"POST /admin/users/:id/demote": { access: "admin" },
	"POST /admin/users/:id/make-instructor": { access: "admin" },
	"POST /admin/users/:id/remove-instructor": { access: "admin" },
	"POST /admin/dex-users": { access: "admin" },
	"POST /admin/dex-users/:id/reset-password": { access: "admin" },
	"POST /admin/dex-users/:id/remove": { access: "admin" },
	"GET /admin/workspaces/:id": { access: "admin" },
	"HEAD /admin/workspaces/:id": { access: "admin" },
	"POST /admin/workspaces/:id/archive": { access: "admin" },
	"POST /admin/workspaces/:id/unarchive": { access: "admin" },
	"PUT /admin/workspaces/:id/quota": { access: "admin" },
	"POST /admin/workspaces/:id/rebuild": { access: "admin" },
	"GET /admin/audit": { access: "admin" },
	"HEAD /admin/audit": { access: "admin" },
	"GET /admin/health": { access: "admin" },
	"HEAD /admin/health": { access: "admin" },

	"GET /__portikus/bootstrap": { access: "preview-edge" },
	"HEAD /__portikus/bootstrap": { access: "preview-edge" },
	"GET /__portikus/reset": { access: "preview-edge" },
	"HEAD /__portikus/reset": { access: "preview-edge" },
	"GET /preview/authorize": { access: "preview-edge" },
	"HEAD /preview/authorize": { access: "preview-edge" },

	"GET /workspaces/:id/preview/:port/*": { access: "inert" },
	"HEAD /workspaces/:id/preview/:port/*": { access: "inert" },
};

/** Split a policy key back into its method and URL pattern. */
export function splitKey(key: string): { method: string; url: string } {
	const space = key.indexOf(" ");
	return { method: key.slice(0, space), url: key.slice(space + 1) };
}
