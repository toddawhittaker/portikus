import { useState } from "react";

/** A section's values: text for a box, true or false for a checkbox. */
export type Values = Record<string, string | boolean>;

/** Text compares without its outer spaces, so " 10" is not a change from "10". */
function same(a: string | boolean, b: string | boolean): boolean {
	return typeof a === "string" && typeof b === "string"
		? a.trim() === b.trim()
		: a === b;
}

/** The fields whose edit differs from the saved value, in the saved values' order. */
export function changedKeys<T extends Values>(
	saved: T,
	draft: Partial<T>,
): (keyof T & string)[] {
	return Object.keys(saved).filter((key) => {
		const edit = draft[key];
		return edit !== undefined && !same(edit, saved[key] as string | boolean);
	});
}

/**
 * What one section is editing: the saved values with the person's edits over
 * them, which fields differ, and whether the last save went through. A save
 * sends only the changed fields, so it never writes over what another
 * administrator changed in a field this person did not touch.
 */
export function useDraft<T extends Values>(saved: T | undefined) {
	const [draft, setDraft] = useState<Partial<T>>({});
	const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
	const [failure, setFailure] = useState<string | null>(null);
	const [justSaved, setJustSaved] = useState(false);
	const changed = saved ? changedKeys(saved, draft) : [];

	return {
		changed,
		errors,
		failure,
		justSaved,
		/** The value to show: the edit, else the saved value. */
		value<K extends keyof T>(key: K): T[K] | undefined {
			return draft[key] ?? saved?.[key];
		},
		isChanged(key: keyof T & string): boolean {
			return changed.includes(key);
		},
		edit<K extends keyof T>(key: K, value: T[K]) {
			setDraft((now) => ({ ...now, [key]: value }));
			setErrors((now) => {
				if (!(key in now)) return now;
				const { [key]: _, ...rest } = now;
				return rest as Partial<Record<keyof T, string>>;
			});
			setFailure(null);
			setJustSaved(false);
		},
		discard() {
			setDraft({});
			setErrors({});
			setFailure(null);
		},
		/** Field errors found before sending; the footer names the first. */
		refuse(found: Partial<Record<keyof T, string>>) {
			setErrors(found);
			setFailure(null);
		},
		/** A save the server refused or never answered; the edits stay. */
		fail(message: string) {
			setFailure(message);
		},
		saved() {
			setDraft({});
			setErrors({});
			setFailure(null);
			setJustSaved(true);
		},
	};
}
