import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type AccessClass, ROUTE_POLICY } from "../security/route-policy.js";
import { NOT_EXPOSED, OPERATIONS, operationByKey, operationByName } from "./index.js";
import type { Audience } from "./types.js";

/**
 * The catalog's coverage rules (SPEC.md section 27): every route a key could
 * reach is either an operation or on the not-exposed list with a reason.
 * `authz-matrix.test.ts` already proves the policy
 * table lists exactly the routes the server registers.
 */

const policyKeys = Object.keys(ROUTE_POLICY).filter((key) => !key.startsWith("HEAD "));
const known = new Set(policyKeys);
const exposed = new Set(Object.keys(OPERATIONS));
const notExposed = new Set(Object.keys(NOT_EXPOSED));

/** Routes no key may ever reach, whatever its scope. Written out here so a change is deliberate. */
const NEVER = [
	"GET /admin/root-shell",
	"GET /admin/root-shell/ws",
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
	"GET /me/links",
	"GET /me/links/pending",
	"POST /me/links/start",
	"POST /me/links/passkey/start",
	"POST /me/links/confirm",
	"POST /me/links/:courseUserId/unlink",
	"POST /admin/users/:id/links",
	"DELETE /admin/users/:id/links/:courseUserId",
	"PATCH /admin/dex-users/:id",
	"POST /admin/dex-users",
	"POST /admin/dex-users/:id/reset-password",
	"POST /admin/accounts/import/preview",
	"POST /admin/accounts/import",
	"PUT /admin/notifications",
	"POST /admin/signin",
	"POST /admin/certificate/jobs",
	"PUT /admin/docker/hub-credential",
	"DELETE /admin/docker/hub-credential",
	"POST /admin/backups/key",
	"POST /admin/backups/key/download",
];

const ACCESS_AUDIENCES: Record<AccessClass, readonly Audience[]> = {
	admin: ["administrator"],
	"course-instructor": ["instructor", "staff"],
	// Acting on the caller's own account or an own-or-any workspace: staff, or
	// administrator-only where only the administrator's way in is exposed.
	self: ["staff"],
	"owner-or-admin": ["administrator", "staff"],
	owner: [],
	// Key management, which no key may ever reach.
	staff: [],
	public: [],
	"preview-edge": [],
	// The MCP door itself, never an operation.
	"api-key": [],
};

/**
 * Operations that loosen a SPEC.md section 24 control (egress, the hosts the
 * platform may reach, trusted course systems, the usage guard and limits) or
 * take away another person's access. A key needs destructive scope for them.
 */
const LOOSENS_OR_REMOVES_ACCESS = [
	"egress.set_mode",
	"egress.set_presets",
	"egress.set_ports",
	"egress.add_entry",
	"egress.update_entry",
	"egress.update_blocked_site",
	"egress.remove_blocked_site",
	"proxy_hosts.set",
	"lms.set",
	"settings.update",
	"users.disable",
	"users.enable",
	"users.revoke_admin",
	"users.revoke_instructor",
	"courses.remove_member",
	"workspaces.archive",
	"workspaces.lift_throttle",
	"workspaces.set_guard",
	"workspaces.set_limits",
	"workspaces.set_quota",
];

describe("route coverage", () => {
	test("the policy table has routes to cover", () => {
		expect(policyKeys.length).toBeGreaterThan(200);
	});

	test.each(policyKeys)("%s is exactly one of exposed or not exposed", (key) => {
		expect(exposed.has(key) !== notExposed.has(key)).toBe(true);
	});

	test("an exposed key names a route", () => {
		for (const key of exposed) {
			expect(known.has(key), `${key} is not a route`).toBe(true);
		}
	});

	test("a not-exposed key names a route", () => {
		for (const key of notExposed) {
			expect(known.has(key), `${key} is not a route`).toBe(true);
		}
	});

	test("every not-exposed entry gives a reason", () => {
		for (const [key, entry] of Object.entries(NOT_EXPOSED)) {
			expect(entry.reason.trim().length, key).toBeGreaterThan(0);
		}
	});
});

describe("the never list", () => {
	test.each(NEVER)("%s is never exposed and marked never", (key) => {
		expect(known.has(key), `${key} is not a route`).toBe(true);
		expect(exposed.has(key)).toBe(false);
		expect(NOT_EXPOSED[key]?.never).toBe(true);
	});

	test("nothing outside the list is marked never", () => {
		const marked = Object.entries(NOT_EXPOSED)
			.filter(([, entry]) => entry.never)
			.map(([key]) => key);
		expect(marked.sort()).toEqual([...NEVER].sort());
	});
});

describe("operations", () => {
	const records = Object.entries(OPERATIONS);

	test("names follow the pattern and are unique", () => {
		const names = records.map(([, op]) => op.name);
		for (const name of names) {
			expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	test("each record has a description and a valid risk and audience", () => {
		for (const [key, op] of records) {
			expect(op.description.trim().length, key).toBeGreaterThan(0);
			expect(["read", "change", "destructive"], key).toContain(op.risk);
			expect(["administrator", "instructor", "staff"], key).toContain(op.audience);
		}
	});

	test("the audience agrees with the route's access class", () => {
		for (const [key, op] of records) {
			const access = ROUTE_POLICY[key]?.access;
			expect(access, `${key} is not in the policy table`).toBeDefined();
			expect(ACCESS_AUDIENCES[access as AccessClass], key).toContain(op.audience);
		}
	});

	test("every input and output schema converts to JSON Schema", () => {
		for (const [key, op] of records) {
			for (const schema of [
				op.input.params,
				op.input.query,
				op.input.body,
				op.output,
			]) {
				if (schema) {
					expect(
						() => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
						key,
					).not.toThrow();
				}
			}
		}
	});

	test("a params schema names exactly the route's path parameters", () => {
		for (const [key, op] of records) {
			const wanted = [...key.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
			const schema = op.input.params;
			const json = schema
				? (z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
						properties?: Record<string, unknown>;
					})
				: {};
			expect(Object.keys(json.properties ?? {}).sort(), key).toEqual(wanted);
		}
	});

	test.each(LOOSENS_OR_REMOVES_ACCESS)(
		"%s loosens a section 24 control or removes someone's access, so it is destructive",
		(name) => {
			expect(operationByName(name)?.operation.risk).toBe("destructive");
		},
	);

	test("lookups find a record by key, by HEAD twin and by name", () => {
		for (const [key, op] of records) {
			expect(operationByKey(key)).toBe(op);
			expect(operationByName(op.name)).toEqual({ key, operation: op });
		}
		expect(operationByKey("GET /no/such/route")).toBeUndefined();
		expect(operationByName("no.such")).toBeUndefined();
	});
});
