import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, for tests that read the docs or scan the source. */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Section 24.11 names these only to say they are no longer written. */
const RETIRED_ACTIONS: ReadonlySet<string> = new Set([
	"setup.code_issued",
	"setup.code_claimed",
]);

/** Every `area.event` name written in backticks in SPEC.md section 24.11. */
export function specActionNames(): string[] {
	const spec = readFileSync(join(REPO_ROOT, "docs/SPEC.md"), "utf8");
	const start = spec.indexOf("### 24.11 Audit logging");
	const end = spec.indexOf("\n### ", start + 1);
	const section = spec.slice(start, end);
	const names = [...section.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1] ?? "");
	return [...new Set(names)].filter((name) => !RETIRED_ACTIONS.has(name)).sort();
}

/** Every file under `dir` that `keep` accepts, skipping node_modules and dist. */
export function walkFiles(
	dir: string,
	keep: (path: string) => boolean,
	out: string[] = [],
): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walkFiles(path, keep, out);
		else if (keep(path)) out.push(path);
	}
	return out;
}
