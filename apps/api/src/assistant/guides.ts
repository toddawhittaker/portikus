import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AssistantRole } from "./tools.js";

/**
 * The guides the assistant answers Portikus questions from (SPEC.md section
 * 20.5): the package carries them beside the API, and a development checkout
 * reads them from docs/. Each is split at its headings; the model searches by
 * plain keyword and reads one section at a time. No embeddings.
 */

export const GUIDE_FILES = [
	"ADMIN-GUIDE.md",
	"OPERATIONS.md",
	"INSTALL.md",
	"INSTRUCTOR-GUIDE.md",
] as const;

/** An instructor reads their own guide only; the others describe the whole site. */
const FILES_BY_ROLE: Record<AssistantRole, readonly string[]> = {
	administrator: GUIDE_FILES,
	instructor: ["INSTRUCTOR-GUIDE.md"],
};

/** Where the build puts the guides, then where a checkout keeps them. */
const GUIDE_DIRS = [
	fileURLToPath(new URL("../../guides", import.meta.url)),
	fileURLToPath(new URL("../../../../docs", import.meta.url)),
];

const MAX_RESULTS = 5;
const EXCERPT_CHARS = 200;
/** About a page of a guide; the model is told when a section is longer. */
export const MAX_SECTION_CHARS = 12_000;

export const GuideSearchArgs = z.object({
	query: z.string().min(1).max(200).describe("Words to look for in the guides."),
});

export const GuideReadArgs = z.object({
	file: z.string().max(100).describe("A guide file name, as guide_search gives it."),
	heading: z
		.string()
		.max(300)
		.describe("A section's heading, exactly as guide_search gives it."),
});

export const GUIDE_SEARCH_TOOL = "guide_search";
export const GUIDE_READ_TOOL = "guide_read";

export const GUIDE_SEARCH_DESCRIPTION =
	"Searches the Portikus guides you may read by keyword and returns up to 5 sections, " +
	"each with its file, heading and a short excerpt. Read one in full with guide_read.";

export const GUIDE_READ_DESCRIPTION =
	"Returns the text of one guide section, by file and heading as guide_search gives them. " +
	'Cite what you use as "FILE § heading".';

type Section = { file: string; heading: string; text: string };

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** One guide split at every heading outside a code fence; a repeated heading gets a number. */
export function splitSections(file: string, markdown: string): Section[] {
	const sections: Section[] = [];
	const seen = new Map<string, number>();
	let current: { heading: string; lines: string[] } | null = null;
	let fenced = false;
	const close = () => {
		if (!current) return;
		const text = current.lines.join("\n").trim();
		const count = (seen.get(current.heading) ?? 0) + 1;
		seen.set(current.heading, count);
		const heading = count === 1 ? current.heading : `${current.heading} (${count})`;
		if (text !== "") sections.push({ file, heading, text });
	};
	for (const line of markdown.split("\n")) {
		if (FENCE.test(line)) fenced = !fenced;
		const match = fenced ? null : HEADING.exec(line);
		if (match?.[2]) {
			close();
			current = { heading: match[2], lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	close();
	return sections;
}

/** Where a guide is installed, or undefined when it is not. */
function guidePath(file: string, dirs: readonly string[]): string | undefined {
	const dir = dirs.find((one) => existsSync(join(one, file)));
	return dir === undefined ? undefined : join(dir, file);
}

/** The installed guides a role may read, each with the path of its whole text. */
export function guideFilesFor(
	role: AssistantRole,
	dirs: readonly string[] = GUIDE_DIRS,
): { file: string; path: string }[] {
	return FILES_BY_ROLE[role].flatMap((file) => {
		const path = guidePath(file, dirs);
		return path === undefined ? [] : [{ file, path }];
	});
}

let loaded: Map<string, Section[]> | undefined;

/** The guides on disk, read once; a missing file is simply not offered. */
function guideSections(dirs: readonly string[] = GUIDE_DIRS): Map<string, Section[]> {
	if (loaded && dirs === GUIDE_DIRS) return loaded;
	const files = new Map<string, Section[]>();
	for (const file of GUIDE_FILES) {
		const path = guidePath(file, dirs);
		if (path) files.set(file, splitSections(file, readFileSync(path, "utf8")));
	}
	if (dirs === GUIDE_DIRS) loaded = files;
	return files;
}

function visible(role: AssistantRole, dirs?: readonly string[]): Section[] {
	const files = guideSections(dirs);
	return FILES_BY_ROLE[role].flatMap((file) => files.get(file) ?? []);
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"how",
	"what",
	"does",
	"can",
	"with",
	"that",
	"this",
	"are",
	"you",
	"from",
	"into",
	"about",
	"portikus",
]);

function terms(query: string): string[] {
	const words = query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
	// A trailing "s" is dropped so "backups" finds "backup"; the match is by substring.
	const stems = words
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
		.map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
	return [...new Set(stems)];
}

function countOf(text: string, term: string): number {
	let count = 0;
	for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) count++;
	return count;
}

function score(section: Section, words: readonly string[]): number {
	const heading = section.heading.toLowerCase();
	const body = section.text.toLowerCase();
	let total = 0;
	for (const word of words) {
		if (heading.includes(word)) total += 5;
		// A few mentions show the section is about it; a hundred do not make it more so.
		total += Math.min(countOf(body, word), 5);
	}
	return total;
}

function excerptOf(section: Section, words: readonly string[]): string {
	const flat = section.text.replace(/\s+/g, " ");
	const lower = flat.toLowerCase();
	const hits = words.map((word) => lower.indexOf(word)).filter((at) => at !== -1);
	const from = hits.length === 0 ? 0 : Math.max(0, Math.min(...hits) - 40);
	const piece = flat.slice(from, from + EXCERPT_CHARS);
	return `${from > 0 ? "…" : ""}${piece}${from + EXCERPT_CHARS < flat.length ? "…" : ""}`;
}

export type GuideHit = { file: string; heading: string; excerpt: string };

/** The best sections for a query among the guides this role may read. */
export function searchGuides(
	role: AssistantRole,
	query: string,
	dirs?: readonly string[],
): GuideHit[] {
	const words = terms(query);
	if (words.length === 0) return [];
	return visible(role, dirs)
		.map((section) => ({ section, points: score(section, words) }))
		.filter((one) => one.points > 0)
		.sort((a, b) => b.points - a.points)
		.slice(0, MAX_RESULTS)
		.map(({ section }) => ({
			file: section.file,
			heading: section.heading,
			excerpt: excerptOf(section, words),
		}));
}

export type GuideRead =
	| { found: true; file: string; heading: string; text: string }
	| { found: false; message: string };

/** One section's text, capped; the files and headings that exist when the name is wrong. */
export function readGuide(
	role: AssistantRole,
	file: string,
	heading: string,
	dirs?: readonly string[],
): GuideRead {
	const sections = visible(role, dirs);
	const inFile = sections.filter((section) => section.file === file);
	if (inFile.length === 0) {
		const names = [...new Set(sections.map((section) => section.file))];
		return {
			found: false,
			message: `There is no guide named ${file} that you may read. The guides are: ${names.join(", ") || "none installed"}.`,
		};
	}
	const wanted = heading.trim().toLowerCase();
	const section = inFile.find((one) => one.heading.toLowerCase() === wanted);
	if (!section) {
		return {
			found: false,
			message: `${file} has no section headed "${heading}". Use guide_search to find the heading.`,
		};
	}
	const text =
		section.text.length <= MAX_SECTION_CHARS
			? section.text
			: `${section.text.slice(0, MAX_SECTION_CHARS)}\n[Truncated: the section is ${section.text.length} characters and only the first ${MAX_SECTION_CHARS} are shown.]`;
	return { found: true, file: section.file, heading: section.heading, text };
}
