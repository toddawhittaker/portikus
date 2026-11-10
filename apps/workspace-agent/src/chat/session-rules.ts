import type { ChatSessionRule } from "@portikus/contracts";

/**
 * Rules granted with Always allow, for one Claude process only. Socket
 * lines are handled concurrently, so changes queue here and each computes
 * its list from the one before it. `apply` writes the whole list to the
 * flag settings layer; an empty list clears it, so a revoke takes effect
 * at once.
 */
export class SessionRules {
	held: ChatSessionRule[] = [];
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly apply: (rules: ChatSessionRule[]) => Promise<void>,
		private readonly onChange: () => void,
	) {}

	grant(rules: ChatSessionRule[]): Promise<void> {
		return this.change((held) => {
			const added = rules.filter(
				(rule) => !held.some((existing) => existing.rule === rule.rule),
			);
			return added.length === 0 ? null : [...held, ...added];
		});
	}

	revoke(rule: string): Promise<void> {
		return this.change((held) =>
			held.some((existing) => existing.rule === rule)
				? held.filter((existing) => existing.rule !== rule)
				: null,
		);
	}

	/** A new Claude process starts with none of the old one's rules. */
	reset(): void {
		if (this.held.length === 0) return;
		this.held = [];
		this.onChange();
	}

	private change(
		next: (held: ChatSessionRule[]) => ChatSessionRule[] | null,
	): Promise<void> {
		const step = this.queue.then(async () => {
			const rules = next(this.held);
			if (rules === null) return;
			await this.apply(rules);
			this.held = rules;
			this.onChange();
		});
		this.queue = step.catch(() => undefined);
		return step;
	}
}
