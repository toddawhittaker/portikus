import { fakeKey } from "./fake-backup-key.js";

/**
 * Valid sample requests for the authorization tests (SPEC.md section 24.1):
 * a request every caller sends unchanged, so only who sent it differs.
 */

/** The query string each route pattern needs to be a valid request. */
export const QUERIES: Record<string, string> = {
	"/workspaces/:id/projects/:pid/file": "?path=notes.txt",
	"/workspaces/:id/projects/:pid/image": "?path=shot.png",
	"/workspaces/:id/projects/:pid/git/diff": "?path=notes.txt",
	"/courses/:courseId/shares/:projectId/file": "?path=notes.txt",
	"/courses/:courseId/shares/:projectId/git/diff": "?path=notes.txt",
	"/workspaces/:id/projects/:pid/recovery-points/:rpid/diff": "?path=notes.txt",
	"/workspaces/:id/projects/:pid/baseline-status": `?object=${"a".repeat(40)}`,
	"/workspaces/:id/projects/:pid/baseline-diff": `?object=${"a".repeat(40)}&path=notes.txt`,
	"/workspaces/:id/projects/:pid/search": "?q=secret",
	"/workspaces/:id/preview/embeddable": "?port=5173",
	"/__portikus/bootstrap": "?t=forged-ticket",
	"/admin/health/series": "?range=1h",
	"/admin/logs/counts": "?range=1h",
	"/admin/egress/entries/:id": "?version=0",
	"/admin/egress/blocked-sites/:id": "?version=0",
};

/** The JSON body each route sends, keyed by `"METHOD url"` as in `ROUTE_POLICY`. */
export const PAYLOADS: Record<string, object> = {
	"POST /mcp": {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "matrix", version: "1.0.0" },
		},
	},
	"POST /me/notifications": { tone: "neutral", title: "Saved" },
	"PATCH /me/notifications/:id": { read: true },
	"POST /me/acceptable-use": { version: 1 },
	"POST /me/api-keys": { name: "Matrix key" },
	"PUT /me/settings": { timezone: "America/New_York" },
	"PUT /me/profile": { github: null },
	"PUT /admin/settings": { logLevel: null },
	"POST /admin/ai/notice": { noticeVersion: 1 },
	"PUT /courses/:courseId/profile": { profile: "traditional" },
	"PUT /admin/courses/:courseId/profile": { profile: "traditional" },
	"PUT /admin/users/:id/settings": { shutdownGraceSeconds: null },
	"POST /admin/dex-users": {
		name: "New Person",
		email: "new@example.edu",
		username: "new",
		role: "student",
	},
	"POST /admin/accounts/import/preview": {
		csv: "name,email,username,role,kind\nA,matrix-a@example.edu,,student,invite\n",
	},
	"POST /admin/accounts/import": {
		csv: "name,email,username,role,kind\nB,matrix-b@example.edu,,student,invite\n",
	},
	"POST /admin/invitations": {
		name: "Invited Person",
		email: "invited@example.edu",
		role: "student",
	},
	"POST /workspaces/:id/terminals": { name: "another" },
	"PATCH /workspaces/:id/terminals/:tid": { name: "renamed" },
	"POST /workspaces/:id/terminals/:tid/question": { id: "toolu_01Q", inTerminal: true },
	"POST /workspaces/:id/projects": { name: "another", source: "new" },
	"POST /workspaces/:id/projects/starter": { starterId: crypto.randomUUID() },
	"PATCH /workspaces/:id/projects/:pid": { name: "renamed" },
	"POST /workspaces/:id/projects/:pid/duplicate": { name: "copy" },
	"PUT /workspaces/:id/projects/:pid/layout": {
		tabs: [{ id: "tab-1", root: { type: "leaf", terminalId: crypto.randomUUID() } }],
	},
	"PUT /workspaces/:id/projects/:pid/chat-settings": {
		model: "opus",
		effort: "low",
		mode: "auto",
	},
	"POST /workspaces/:id/projects/:pid/mkdir": { path: "made" },
	"POST /workspaces/:id/projects/:pid/file-search": { query: "notes" },
	"POST /workspaces/:id/projects/:pid/move": { from: "notes.txt", to: "moved.txt" },
	"POST /workspaces/:id/projects/:pid/extract": { path: "starter.zip" },
	"POST /workspaces/:id/preview-grants": { port: 5173, presentation: "embedded" },
	"POST /workspaces/:id/projects/:pid/live-help": {
		helperUserId: crypto.randomUUID(),
		courseId: crypto.randomUUID(),
	},
	"POST /workspaces/:id/live-help/typing": { typing: true },
	"POST /courses/:courseId/live-help/:sid/preview-grants": {
		port: 5173,
		presentation: "embedded",
	},
	// The fake agent's own node process.
	"POST /workspaces/:id/processes/:pid/stop": { startTicks: 100 },
	"POST /workspaces/:id/processes/:pid/stop-tree": { startTicks: 100 },
	"POST /workspaces/:id/processes/:pid/lower-priority": { startTicks: 100 },
	"POST /admin/workspaces/:id/processes/:pid/stop": { startTicks: 100 },
	"PUT /admin/workspaces/:id/quota": { homeGiB: 100, dockerGiB: 100 },
	"PUT /admin/workspaces/:id/guard": { idleStopMinutes: 0 },
	"PUT /workspaces/:id/keep-running": {
		until: new Date(Date.now() + 3_600_000).toISOString(),
	},
	"PUT /admin/workspaces/:id/limits": { cpu: null, memoryMiB: null, processes: null },
	"POST /admin/workspaces/:id/rebuild": { resetDocker: false },
	"PUT /admin/egress/mode": { version: 0, mode: "open" },
	"PUT /admin/egress/presets": { version: 0, presets: [] },
	"PUT /admin/egress/ports": { version: 0, ports: [22, 80, 443] },
	"POST /admin/egress/entries": {
		version: 0,
		kind: "host",
		value: "example.edu",
		label: "",
	},
	"PUT /admin/egress/entries/:id": {
		version: 0,
		kind: "host",
		value: "example.edu",
		label: "",
	},
	"POST /admin/egress/blocked-sites": { version: 0, value: "example.edu", label: "" },
	"PUT /admin/egress/blocked-sites/:id": {
		version: 0,
		value: "example.edu",
		label: "",
	},
	"POST /admin/backups/key": { key: fakeKey("matrix upload").file, replace: true },
	"POST /admin/backups/restores": {
		stamp: "20260924T023000Z",
		workspaceId: "550e8400-e29b-41d4-a716-446655440000",
	},
};
