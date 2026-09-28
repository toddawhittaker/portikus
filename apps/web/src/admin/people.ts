import type { AdminUser } from "@portikus/contracts";
import { UUID } from "../links.js";

/** One person the Logs and Audit Person fields offer (SPEC.md section 24.11). */
export interface PersonOption {
	id: string;
	/** What the list shows and the field holds: the name, with the email when two share it. */
	label: string;
	workspaceId: string | null;
}

/** Every account as a Person choice, sorted by label. */
export function personOptions(users: readonly AdminUser[]): PersonOption[] {
	const counts = new Map<string, number>();
	for (const user of users) {
		const key = user.displayName.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return users
		.map((user) => {
			const shared = (counts.get(user.displayName.toLowerCase()) ?? 0) > 1;
			const extra = user.email ?? user.preferredUsername ?? user.id.slice(0, 8);
			return {
				id: user.id,
				label: shared ? `${user.displayName} (${extra})` : user.displayName,
				workspaceId: user.workspace?.id ?? null,
			};
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** The field text for a user ID: the person's label, or the ID when they are not listed. */
export function personLabel(options: readonly PersonOption[], id: string): string {
	return options.find((option) => option.id === id)?.label ?? id;
}

export const PERSON_UNKNOWN_TEXT = "Choose a person from the list.";
export const PERSON_AMBIGUOUS_TEXT =
	"More than one person has that name. Choose one from the list.";
export const PERSON_LOADING_TEXT =
	"The list of people is still loading. Try again in a moment.";

/**
 * The user ID a Person entry means: "" for blank, a pasted full ID as itself,
 * else the one listed person whose label, name, email or username it matches
 * in any case. `users` is undefined while the list loads.
 */
export function resolvePerson(
	text: string,
	users: readonly AdminUser[] | undefined,
): { id: string } | { error: string } {
	const typed = text.trim();
	if (typed === "") return { id: "" };
	if (UUID.test(typed)) return { id: typed.toLowerCase() };
	if (!users) return { error: PERSON_LOADING_TEXT };
	const wanted = typed.toLowerCase();
	const byLabel = personOptions(users).find(
		(option) => option.label.toLowerCase() === wanted,
	);
	if (byLabel) return { id: byLabel.id };
	const found = users.filter((user) =>
		[user.displayName, user.email, user.preferredUsername].some(
			(value) => value?.toLowerCase() === wanted,
		),
	);
	const [only] = found;
	if (found.length === 1 && only) return { id: only.id };
	if (found.length > 1) return { error: PERSON_AMBIGUOUS_TEXT };
	return { error: PERSON_UNKNOWN_TEXT };
}

/** The workspace filter's checkbox label: whose workspace it is, when known. */
export function workspaceLabel(options: readonly PersonOption[], id: string): string {
	const owner = options.find((option) => option.workspaceId === id);
	return owner ? `Only ${owner.label}'s workspace` : `Only workspace ${id.slice(0, 8)}`;
}
