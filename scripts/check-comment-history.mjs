#!/usr/bin/env node
// Fails when a code comment or test title carries project history (issue
// numbers, epic or task names, rulings, review codes, plan pointers) instead
// of citing SPEC.md sections or ADRs. Rules: .claude/agents/builder.md, "Code quality".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PATTERNS = [
	{ name: "issue reference", re: /\bissues? #?\d+/gi },
	// Two to five digits: skips HTML entities like &#43;, hex colours with a letter
	// and six- or eight-digit colours such as #333333.
	{ name: "issue reference", re: /(?<![&\w])#\d{2,5}(?![\w])/g },
	{ name: "pull request reference", re: /\bPRs? #?\d+/g },
	{ name: "epic reference", re: /\bEpics? \d+/gi },
	{ name: "task reference", re: /\b[Tt]asks? T?\d+\b/g },
	{ name: "ruling reference", re: /\brulings? [A-Z]?\d+/gi },
	{ name: "review code", re: /\breview [A-Z]\d+/gi },
	{ name: "epic plan pointer", re: /docs\/archive\/epics|EPIC-\d/g },
];

// Text that matches a pattern but is not history.
const ALLOWED = [
	// ADR 0034 numbers its own rulings, so citing one is a citation of the ADR.
	/ADR 0034,? rulings? \d+/g,
];

// Extensionless scripts that carry hash comments.
const HASH_SCRIPTS = new Set([
	"infra/host/portikus-backup-export",
	"infra/host/portikus-backup-mac",
	"packaging/backup/backup-key",
	"packaging/bin/portikus",
	"packaging/certificate/certificate-job",
	"packaging/debian/config",
	"packaging/image/image-job",
	"packaging/registry/registry-job",
	"packaging/scripts/postinst",
	"packaging/scripts/postrm",
	"packaging/scripts/prerm",
]);

// Paths not scanned.
const SKIPPED = [
	// Design mockups are mirrored from the external design tool, not written here.
	/^design\//,
	// This check's own tests hold the patterns it rejects, as examples.
	/^scripts\/check-comment-history\.test\.ts$/,
];

function kindOf(path) {
	if (SKIPPED.some((re) => re.test(path))) return null;
	const base = path.split("/").pop();
	if (base === "Makefile" || /(^|\/)mk\/[^/]+\.mk$/.test(path)) return "hash";
	if (/\.(ts|tsx|mts|cts|mjs|cjs|js|css)$/.test(path)) return "c";
	if (HASH_SCRIPTS.has(path)) return "hash";
	if (/\.(sh|bash|ya?ml|py|tf|service|timer)$/.test(path)) return "hash";
	if (/\.j2$/.test(path)) return "jinja";
	return null;
}

// Skips the string literal opening at i; returns the index past it and the line.
function skipString(src, start, startLine) {
	const quote = src[start];
	let i = start + 1;
	let line = startLine;
	while (i < src.length && src[i] !== quote) {
		if (src[i] === "\\") {
			i++;
		} else if (src[i] === "\n") {
			line++;
			if (quote !== "`") break;
		}
		i++;
	}
	return { i: i + 1, line };
}

// Returns [{ line, text }] per comment line; string literals are skipped so
// "https://" inside a string is not taken for a comment.
function cComments(src) {
	const out = [];
	let line = 1;
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\n") {
			line++;
			i++;
		} else if (ch === "/" && src[i + 1] === "/") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out.push({ line, text: src.slice(i + 2, stop) });
			i = stop;
		} else if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end;
			const lines = src.slice(i + 2, stop).split("\n");
			lines.forEach((text, n) => {
				out.push({ line: line + n, text });
			});
			line += lines.length - 1;
			i = stop + 2;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			({ i, line } = skipString(src, i, line));
		} else {
			i++;
		}
	}
	return out;
}

function hashComments(src) {
	const out = [];
	src.split("\n").forEach((text, n) => {
		const at = text.search(/(^|\s)#(?!!)/);
		if (at !== -1) out.push({ line: n + 1, text: text.slice(at) });
	});
	return out;
}

function jinjaComments(src) {
	// Blank out {# #} blocks first so the hash scan does not see them twice.
	const out = hashComments(
		src.replace(/\{#[\s\S]*?#\}/g, (m) => m.replace(/[^\n]/g, " ")),
	);
	for (const m of src.matchAll(/\{#([\s\S]*?)#\}/g)) {
		const first = src.slice(0, m.index).split("\n").length;
		m[1].split("\n").forEach((text, n) => {
			out.push({ line: first + n, text });
		});
	}
	return out;
}

function testTitles(src) {
	const out = [];
	const re = /\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
	for (const m of src.matchAll(re)) {
		out.push({ line: src.slice(0, m.index).split("\n").length, text: m[2] });
	}
	return out;
}

export function scanText(path, src) {
	const kind = kindOf(path);
	if (!kind) return [];
	let spans;
	if (kind === "c") spans = cComments(src);
	else if (kind === "jinja") spans = jinjaComments(src);
	else spans = hashComments(src);
	if (/\.(test|spec)\.tsx?$/.test(path)) spans = spans.concat(testTitles(src));
	const hits = [];
	for (const { line, text } of spans) {
		let clean = text;
		for (const allow of ALLOWED) clean = clean.replace(allow, "");
		// One hit per comment line is enough to point the reader at it.
		for (const { name, re } of PATTERNS) {
			const m = clean.match(new RegExp(re.source, re.flags.replace("g", "")));
			if (m) {
				hits.push({ path, line, name, match: m[0] });
				break;
			}
		}
	}
	return hits;
}

function main() {
	const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
		.split("\n")
		.filter((f) => f && kindOf(f));
	const hits = [];
	for (const f of files) {
		let src;
		try {
			src = readFileSync(f, "utf8");
		} catch {
			continue; // listed but deleted in the working tree
		}
		hits.push(...scanText(f, src));
	}
	for (const h of hits) console.log(`${h.path}:${h.line}: ${h.name}: ${h.match}`);
	if (hits.length > 0) {
		console.error(
			`\n${hits.length} comment(s) carry project history. Cite a SPEC.md section or an ADR instead.`,
		);
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
