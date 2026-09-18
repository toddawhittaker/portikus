/**
 * The icon a file row draws (SPEC.md §11.2). The name decides: a handful of
 * well-known file names first, then the extension, then a generic file.
 *
 * This is a separate table from apps/web/src/editor/language.ts on purpose:
 * that one guesses a Monaco language from a shebang or a first line, which
 * the tree never reads.
 */
import type { IconName } from "@portikus/ui";

/** Whole file names that pick an icon on their own. */
const BY_NAME: Record<string, IconName> = {
	dockerfile: "file-config",
	containerfile: "file-config",
	makefile: "file-config",
	gnumakefile: "file-config",
	".gitignore": "file-config",
	".gitattributes": "file-config",
	".editorconfig": "file-config",
	".env": "file-config",
	license: "file-markdown",
	readme: "file-markdown",
};

/** Extensions, lower case and without the dot. */
const BY_EXTENSION: Record<string, IconName> = {
	// Code.
	ts: "file-code",
	tsx: "file-code",
	js: "file-code",
	jsx: "file-code",
	mjs: "file-code",
	cjs: "file-code",
	py: "file-code",
	java: "file-code",
	c: "file-code",
	h: "file-code",
	cpp: "file-code",
	hpp: "file-code",
	cs: "file-code",
	go: "file-code",
	rs: "file-code",
	rb: "file-code",
	php: "file-code",
	swift: "file-code",
	kt: "file-code",
	sh: "file-code",
	bash: "file-code",
	zsh: "file-code",
	sql: "file-code",
	// Web.
	html: "file-web",
	htm: "file-web",
	css: "file-web",
	scss: "file-web",
	less: "file-web",
	svg: "file-image",
	// Data.
	json: "file-data",
	jsonc: "file-data",
	yaml: "file-data",
	yml: "file-data",
	toml: "file-data",
	csv: "file-data",
	tsv: "file-data",
	xml: "file-data",
	// Prose.
	md: "file-markdown",
	markdown: "file-markdown",
	mdx: "file-markdown",
	// Pictures.
	png: "file-image",
	jpg: "file-image",
	jpeg: "file-image",
	gif: "file-image",
	webp: "file-image",
	ico: "file-image",
	bmp: "file-image",
	// Archives.
	zip: "file-archive",
	tar: "file-archive",
	gz: "file-archive",
	tgz: "file-archive",
	bz2: "file-archive",
	xz: "file-archive",
	jar: "file-archive",
	// Settings and lock files.
	lock: "file-config",
	ini: "file-config",
	cfg: "file-config",
	conf: "file-config",
	env: "file-config",
};

/** The extension of a file name, lower case and without the dot. */
function extensionOf(name: string): string {
	const cut = name.lastIndexOf(".");
	// A leading dot is part of the name, as in .gitignore, not an extension.
	if (cut <= 0) return "";
	return name.slice(cut + 1).toLowerCase();
}

/** The icon for a file called `name`. Directories use their own icons. */
export function fileIconName(name: string): IconName {
	const lower = name.toLowerCase();
	const named = BY_NAME[lower];
	if (named) return named;
	// package-lock.json and pnpm-lock.yaml read as settings, not as data.
	if (lower.includes("lock") && (lower.endsWith(".json") || lower.endsWith(".yaml"))) {
		return "file-config";
	}
	return BY_EXTENSION[extensionOf(name)] ?? "file";
}
