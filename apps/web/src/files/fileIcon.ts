/**
 * The icon a file row draws (SPEC.md §11.2). The name decides: a handful of
 * well-known file names first, then a .env prefix, then the extension, then
 * a generic file.
 *
 * This is a separate table from apps/web/src/editor/language.ts on purpose:
 * that one guesses a Monaco language from a shebang or a first line, which
 * the tree never reads.
 */
import type { IconName } from "@portikus/ui";

/** Whole file names, lower case, that pick an icon on their own. */
const BY_NAME: Record<string, IconName> = {
	dockerfile: "file-config",
	containerfile: "file-config",
	makefile: "file-config",
	gnumakefile: "file-config",
	".gitignore": "file-config",
	".gitattributes": "file-config",
	".editorconfig": "file-config",
	license: "file-markdown",
	readme: "file-markdown",
	// Lock files a package manager writes; matched whole so data.json stays data.
	"package-lock.json": "file-lock",
	"pnpm-lock.yaml": "file-lock",
	"yarn.lock": "file-lock",
	"poetry.lock": "file-lock",
	"cargo.lock": "file-lock",
};

/** Extensions, lower case and without the dot. */
const BY_EXTENSION: Record<string, IconName> = {
	// Source files, one tagged icon per language.
	py: "file-python",
	java: "file-java",
	js: "file-javascript",
	mjs: "file-javascript",
	cjs: "file-javascript",
	jsx: "file-javascript",
	ts: "file-typescript",
	tsx: "file-typescript",
	c: "file-c",
	h: "file-c",
	cpp: "file-cpp",
	hpp: "file-cpp",
	sql: "file-sql",
	sh: "file-shell",
	bash: "file-shell",
	zsh: "file-shell",
	go: "file-go",
	rs: "file-rust",
	cs: "file-csharp",
	rb: "file-ruby",
	php: "file-php",
	kt: "file-kotlin",
	swift: "file-swift",
	// Web pages, then styles.
	html: "file-web",
	htm: "file-web",
	css: "file-style",
	scss: "file-style",
	sass: "file-style",
	less: "file-style",
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
	docx: "file-text",
	odt: "file-text",
	txt: "file-text",
	rtf: "file-text",
	pdf: "file-pdf",
	xlsx: "file-sheet",
	ods: "file-sheet",
	ipynb: "file-notebook",
	// Pictures, sound and video.
	png: "file-image",
	jpg: "file-image",
	jpeg: "file-image",
	gif: "file-image",
	webp: "file-image",
	ico: "file-image",
	bmp: "file-image",
	mp3: "file-audio",
	wav: "file-audio",
	ogg: "file-audio",
	flac: "file-audio",
	m4a: "file-audio",
	mp4: "file-video",
	webm: "file-video",
	mov: "file-video",
	mkv: "file-video",
	avi: "file-video",
	// Fonts.
	ttf: "file-font",
	otf: "file-font",
	woff: "file-font",
	woff2: "file-font",
	// Archives.
	zip: "file-archive",
	tar: "file-archive",
	gz: "file-archive",
	tgz: "file-archive",
	bz2: "file-archive",
	xz: "file-archive",
	jar: "file-archive",
	// Secrets: keys and certificates a student should notice.
	pem: "file-key",
	key: "file-key",
	env: "file-key",
	// Settings.
	lock: "file-lock",
	ini: "file-config",
	cfg: "file-config",
	conf: "file-config",
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
	// .env, .env.local, .env.production and the like hold secrets.
	if (lower === ".env" || lower.startsWith(".env.")) return "file-key";
	return BY_EXTENSION[extensionOf(name)] ?? "file";
}
