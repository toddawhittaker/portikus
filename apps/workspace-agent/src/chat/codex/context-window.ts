import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The context window of a Codex model before any turn has reported it
 * (SPEC.md section 10.8). The last figure Codex reported for the model wins;
 * otherwise Codex's own model cache is read, and null means not known.
 */
export class CodexContextWindows {
	private readonly seen = new Map<string, number>();

	constructor(private readonly homeDir: string) {}

	remember(model: string, window: number | null): void {
		if (model && window) this.seen.set(model, window);
	}

	async of(model: string): Promise<number | null> {
		if (!model) return null;
		return this.seen.get(model) ?? (await this.fromCache(model));
	}

	/** Codex's cache is private, so any surprise in it means no answer. */
	private async fromCache(model: string): Promise<number | null> {
		try {
			const dir = process.env.CODEX_HOME || join(this.homeDir, ".codex");
			const json: unknown = JSON.parse(
				await readFile(join(dir, "models_cache.json"), "utf8"),
			);
			const models = Array.isArray(json)
				? json
				: (json as { models?: unknown })?.models;
			if (!Array.isArray(models)) return null;
			const entry = models.find(
				(row): row is Record<string, unknown> =>
					typeof row === "object" && row !== null && row.slug === model,
			);
			const window = entry?.context_window;
			if (typeof window !== "number" || !(window > 0)) return null;
			const percent = entry?.effective_context_window_percent;
			const effective = typeof percent === "number" && percent > 0 ? percent : 100;
			return Math.round((window * effective) / 100);
		} catch {
			return null;
		}
	}
}
