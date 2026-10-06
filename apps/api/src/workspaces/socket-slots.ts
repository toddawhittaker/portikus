/**
 * A per-key count of open sockets with a ceiling. The control plane counts
 * these itself rather than trusting the agent, whose port is inside the
 * workspace where student code runs (SPEC.md §24.1). Counts are per API
 * process; the pilot runs one (ADR 0010).
 */
export interface SocketSlots {
	/** Take a slot for `key`, or false when all of them are in use. */
	take: (key: string) => boolean;
	/** Give a slot back. */
	release: (key: string) => void;
	/** Slots `key` holds now. */
	open: (key: string) => number;
}

export function createSocketSlots(max: number): SocketSlots {
	const counts = new Map<string, number>();
	return {
		take(key) {
			const open = counts.get(key) ?? 0;
			if (open >= max) return false;
			counts.set(key, open + 1);
			return true;
		},
		release(key) {
			const open = (counts.get(key) ?? 1) - 1;
			if (open <= 0) counts.delete(key);
			else counts.set(key, open);
		},
		open(key) {
			return counts.get(key) ?? 0;
		},
	};
}
