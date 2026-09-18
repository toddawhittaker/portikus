/**
 * Directory names that hold generated or version-control data. The watcher
 * skips them today; the file tree and search will use this list later in
 * this epic (SPEC.md §11.4).
 */
export const GENERATED_NAMES = [
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
	"target",
	"__pycache__",
];
