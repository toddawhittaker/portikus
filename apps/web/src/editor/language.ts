/**
 * Guessing a language when the file name does not give one away
 * (SPEC.md §13.2). A small table, not a dependency: the first line of the
 * file and a handful of well-known file names cover the cases students meet,
 * such as .git/hooks/pre-applypatch.sample, which is a shell script with a
 * .sample extension.
 *
 * The ids returned here are Monaco language ids. The caller checks that the
 * id is actually registered before using it.
 */

/** File names that name their language without an extension. */
const BY_FILENAME: ReadonlyArray<readonly [RegExp, string]> = [
	[/^makefile$/i, "makefile"],
	[/^gnumakefile$/i, "makefile"],
	[/^dockerfile(\..+)?$/i, "dockerfile"],
	[/^containerfile$/i, "dockerfile"],
	[/^\.?(bash|zsh)(rc|_profile|_login|_logout|env)$/i, "shell"],
	[/^\.profile$/i, "shell"],
];

/** Interpreters named on a shebang line, matched against the program name. */
const BY_INTERPRETER: ReadonlyArray<readonly [RegExp, string]> = [
	[/^(ba|z|k|da)?sh$/, "shell"],
	[/^python[\d.]*$/, "python"],
	[/^node(js)?$/, "javascript"],
	[/^perl[\d.]*$/, "perl"],
	[/^ruby$/, "ruby"],
];

/** First lines that give the format away without a shebang. */
const BY_FIRST_LINE: ReadonlyArray<readonly [RegExp, string]> = [
	[/^<\?xml\b/i, "xml"],
	[/^<!doctype\s+html\b/i, "html"],
	[/^<html\b/i, "html"],
	[/^<\w/, "xml"],
	[/^[[{]/, "json"],
];

/**
 * The program a shebang line runs, or null. Handles both `#!/bin/sh` and
 * `#!/usr/bin/env python3`.
 */
function shebangProgram(firstLine: string): string | null {
	const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
	if (!match) return null;
	const command = match[1] ?? "";
	const program = command.split("/").pop() ?? command;
	if (program === "env") {
		const next = match[2];
		if (!next || next.includes("=")) return null;
		return next.split("/").pop() ?? null;
	}
	return program;
}

/**
 * A guess at the language id for a file whose extension said nothing, or
 * null when nothing matched.
 */
export function detectLanguage(fileName: string, firstLine: string): string | null {
	for (const [pattern, id] of BY_FILENAME) {
		if (pattern.test(fileName)) return id;
	}
	const line = firstLine.replace(/^﻿/, "").trim();
	const program = shebangProgram(line);
	if (program !== null) {
		for (const [pattern, id] of BY_INTERPRETER) {
			if (pattern.test(program)) return id;
		}
		// A shebang with an interpreter we do not know is still a script.
		return null;
	}
	for (const [pattern, id] of BY_FIRST_LINE) {
		if (pattern.test(line)) return id;
	}
	return null;
}
