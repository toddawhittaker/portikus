import {
	type AdminApiKey,
	AdminApiKeyList,
	ApiKeyActionResult,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";
import { plural } from "../../text.js";

/** The administrator's view of every API key (SPEC.md sections 24.8 and 24.13). */

const ADMIN_API_KEYS = ["admin", "api-keys"];

export type KeyVerb = "expire" | "revoke";

/** What one expire or revoke reaches: one key, one person's keys, or every key on the site. */
export type KeyTarget =
	| { kind: "key"; key: AdminApiKey }
	| { kind: "person"; userId: string; name: string }
	| { kind: "all" };

export function useAdminApiKeys(enabled = true) {
	return useQuery({
		queryKey: ADMIN_API_KEYS,
		queryFn: () => request(AdminApiKeyList, "/admin/api-keys"),
		enabled,
	});
}

export function keyActionUrl(verb: KeyVerb, target: KeyTarget): string {
	switch (target.kind) {
		case "key":
			return `/admin/api-keys/${target.key.id}/${verb}`;
		case "person":
			return `/admin/users/${target.userId}/api-keys/${verb}`;
		case "all":
			return `/admin/api-keys/${verb}-all`;
	}
}

export function useKeyAction() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ verb, target }: { verb: KeyVerb; target: KeyTarget }) =>
			sendJson(ApiKeyActionResult, keyActionUrl(verb, target), {}),
		onSettled: () =>
			client.invalidateQueries({ queryKey: ADMIN_API_KEYS, exact: true }),
	});
}

/** The keys a target reaches, from the full list. */
export function keysOf(keys: readonly AdminApiKey[], target: KeyTarget): AdminApiKey[] {
	switch (target.kind) {
		case "key":
			return keys.filter((key) => key.id === target.key.id);
		case "person":
			return keys.filter((key) => key.owner.id === target.userId);
		case "all":
			return [...keys];
	}
}

/**
 * How many keys an action changes: expiring reaches only active keys;
 * revoking reaches active and expired ones. A revoked key is never changed.
 */
export function affectedCount(keys: readonly AdminApiKey[], verb: KeyVerb): number {
	return keys.filter((key) =>
		verb === "expire" ? key.state === "active" : key.state !== "revoked",
	).length;
}

/** The confirm's words: what is reached, how many keys, and what the owners can still do. */
export function confirmText(
	verb: KeyVerb,
	target: KeyTarget,
	count: number,
): { title: string; description: string; confirmLabel: string } {
	const keys = plural(count, "key");
	const what =
		target.kind === "key"
			? `${target.key.name}, ${target.key.owner.displayName}'s key`
			: target.kind === "person"
				? `all of ${target.name}'s keys`
				: "every API key on the site";
	const verbWord = verb === "expire" ? "Expire" : "Revoke";
	const title = `${verbWord} ${what}?`;
	const reach =
		count === 0
			? `No keys would change: there are no ${verb === "expire" ? "active" : "active or expired"} keys here.`
			: `This affects ${keys}, which stop${count === 1 ? "s" : ""} working at once.`;
	const after =
		verb === "expire"
			? "An expired key can be renewed by its owner when they sign in, so use Revoke for a key that may have leaked."
			: "A revoked key can never be renewed; its owner would have to create a new one. This cannot be undone. Expired keys, by contrast, can be renewed by their owners.";
	const notice = "Owners other than you get a notification.";
	return {
		title,
		description: `${reach} ${after} ${notice}`,
		confirmLabel:
			count === 1 || target.kind === "key" ? `${verbWord} key` : `${verbWord} ${keys}`,
	};
}
