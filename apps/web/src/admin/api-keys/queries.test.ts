/** The administrator's expire and revoke actions (SPEC.md section 24.13). */
import type { AdminApiKey } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	affectedCount,
	confirmText,
	type KeyTarget,
	keyActionUrl,
	keysOf,
} from "./queries.js";

function key(id: string, state: AdminApiKey["state"], ownerId = "o1"): AdminApiKey {
	return {
		id,
		name: `Key ${id}`,
		prefix: `portikus_${id}`,
		scope: "read",
		periodDays: 30,
		state,
		createdAt: "2026-11-01T00:00:00.000Z",
		expiresAt: "2026-12-01T00:00:00.000Z",
		lastUsedAt: null,
		revokedAt: state === "revoked" ? "2026-11-10T00:00:00.000Z" : null,
		owner: {
			id: ownerId,
			displayName: ownerId === "o1" ? "Ada" : "Ben",
			role: "instructor",
		},
	};
}

const KEYS = [
	key("a", "active"),
	key("b", "expired"),
	key("c", "revoked"),
	key("d", "active", "o2"),
];

test("each target has its own route", () => {
	const one: KeyTarget = { kind: "key", key: KEYS[0] as AdminApiKey };
	expect(keyActionUrl("expire", one)).toBe("/admin/api-keys/a/expire");
	expect(keyActionUrl("revoke", { kind: "person", userId: "o1", name: "Ada" })).toBe(
		"/admin/users/o1/api-keys/revoke",
	);
	expect(keyActionUrl("expire", { kind: "all" })).toBe("/admin/api-keys/expire-all");
	expect(keyActionUrl("revoke", { kind: "all" })).toBe("/admin/api-keys/revoke-all");
});

test("expiring reaches only active keys; revoking reaches active and expired ones", () => {
	expect(affectedCount(KEYS, "expire")).toBe(2);
	expect(affectedCount(KEYS, "revoke")).toBe(3);
	const ada = keysOf(KEYS, { kind: "person", userId: "o1", name: "Ada" });
	expect(ada.map((k) => k.id)).toEqual(["a", "b", "c"]);
	expect(affectedCount(ada, "expire")).toBe(1);
	expect(affectedCount(ada, "revoke")).toBe(2);
	expect(keysOf(KEYS, { kind: "all" })).toHaveLength(4);
});

test("the confirm says how many keys and that expired keys renew while revoked ones never do", () => {
	const expire = confirmText("expire", { kind: "all" }, 2);
	expect(expire.title).toBe("Expire every API key on the site?");
	expect(expire.description).toContain("This affects 2 keys");
	expect(expire.description).toContain("can be renewed by its owner");
	expect(expire.confirmLabel).toBe("Expire 2 keys");

	const revoke = confirmText(
		"revoke",
		{ kind: "person", userId: "o1", name: "Ada" },
		2,
	);
	expect(revoke.title).toBe("Revoke all of Ada's keys?");
	expect(revoke.description).toContain("This affects 2 keys");
	expect(revoke.description).toContain("can never be renewed");
	expect(revoke.description).toContain("cannot be undone");
	expect(revoke.description).toContain("Expired keys, by contrast, can be renewed");

	const one = confirmText("revoke", { kind: "key", key: KEYS[0] as AdminApiKey }, 1);
	expect(one.title).toBe("Revoke Key a, Ada's key?");
	expect(one.description).toContain("This affects 1 key, which stops working");
	expect(one.confirmLabel).toBe("Revoke key");

	expect(confirmText("expire", { kind: "all" }, 0).description).toContain(
		"No keys would change",
	);
});
