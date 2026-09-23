import { STALE_AFTER_DAYS } from "@portikus/contracts";

/** What the marker rules need to know about one account (issue #302). */
export interface MarkerInput {
	id: string;
	email: string | null;
	/** The last sign-in, or null when none was ever recorded. */
	lastLoginAt: Date | null;
}

export interface AccountFlags {
	duplicateEmail: boolean;
	stale: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function emailKey(email: string | null): string | null {
	if (email === null) return null;
	const key = email.trim().toLowerCase();
	return key === "" ? null : key;
}

/**
 * Duplicate and stale flags for every account, keyed by id. An account is
 * stale when it has not signed in for STALE_AFTER_DAYS days, or when another
 * account with the same email signed in more recently.
 */
export function accountFlags(
	users: readonly MarkerInput[],
	now: Date,
): Map<string, AccountFlags> {
	const byEmail = new Map<string, MarkerInput[]>();
	for (const user of users) {
		const key = emailKey(user.email);
		if (key === null) continue;
		byEmail.set(key, [...(byEmail.get(key) ?? []), user]);
	}

	const cutoff = now.getTime() - STALE_AFTER_DAYS * DAY_MS;
	const flags = new Map<string, AccountFlags>();
	for (const user of users) {
		const key = emailKey(user.email);
		const group = key === null ? [user] : (byEmail.get(key) ?? [user]);
		const mine = user.lastLoginAt?.getTime() ?? null;
		const newerTwin = group.some(
			(other) =>
				other.id !== user.id &&
				other.lastLoginAt !== null &&
				(mine === null || other.lastLoginAt.getTime() > mine),
		);
		flags.set(user.id, {
			duplicateEmail: group.length > 1,
			stale: mine === null || mine < cutoff || newerTwin,
		});
	}
	return flags;
}

/**
 * Keep the given order, but pull every account that shares an email up
 * beside the first of them, so duplicates sit next to each other.
 */
export function groupByEmail<T extends { email: string | null }>(
	users: readonly T[],
): T[] {
	const out: T[] = [];
	const placed = new Set<string>();
	for (const user of users) {
		const key = emailKey(user.email);
		if (key === null) {
			out.push(user);
			continue;
		}
		if (placed.has(key)) continue;
		placed.add(key);
		out.push(...users.filter((other) => emailKey(other.email) === key));
	}
	return out;
}
