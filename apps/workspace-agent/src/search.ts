import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import {
	MAX_SEARCH_MATCHES,
	SEARCH_TIMEOUT_MS,
	type SearchMatch,
	type SearchResponse,
} from "@portikus/contracts";
import { resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";

export interface SearchOptions {
	hidden: boolean;
	signal?: AbortSignal;
	/** Test seam: receives the ripgrep child as soon as it is spawned. */
	onChild?: (child: ChildProcess) => void;
}

/** The longest slice of any line we return; --max-columns does nothing in JSON mode. */
const MAX_LINE_CHARS = 300;

/** How much line text one search may take from ripgrep before it gives up. */
const MAX_TEXT_BYTES = 1024 * 1024;

/** One line of a ripgrep `--json` stream, as much of it as we read. */
interface RgLine {
	type: string;
	data?: {
		path?: { text?: string };
		lines?: { text?: string };
		line_number?: number;
		submatches?: { start?: number }[];
	};
}

/**
 * Search one project with ripgrep (STACK.md §10). The query is always a
 * literal and is passed as an argument, never through a shell, and neither
 * the query nor any match text is logged (STACK.md §15).
 */
export async function searchProject(
	homeDir: string,
	slug: string,
	query: string,
	options: SearchOptions,
): Promise<SearchResponse> {
	const project = await resolveProject(slug, homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	if (options.signal?.aborted) {
		return { matches: [], truncated: false };
	}

	const args = [
		"--json",
		"-F",
		"-S",
		"-C1",
		"--max-count",
		"50",
		"--max-columns",
		"300",
		"--max-filesize",
		"1M",
		"--no-follow",
	];
	if (options.hidden) {
		args.push("-uu");
	}
	args.push("--", query, project.path);

	const child = spawn("rg", args, {
		stdio: ["ignore", "pipe", "pipe"],
		// An rg config file could otherwise inject flags such as --pre.
		env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
	});
	options.onChild?.(child);

	const matches: SearchMatch[] = [];
	let truncated = false;
	// Once we stop the child ourselves, its exit code means nothing.
	let stopped = false;
	const stop = () => {
		if (!stopped) {
			stopped = true;
			child.kill("SIGKILL");
		}
	};

	const timer = setTimeout(() => {
		truncated = true;
		stop();
	}, SEARCH_TIMEOUT_MS);
	const onAbort = () => stop();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	// A context line before a match belongs to that match; one after belongs
	// to the match we last saw. With -C1 there is at most one of each.
	let pendingBefore: { line: number; text: string } | undefined;
	// Counted before slicing, because that is the text ripgrep made us handle.
	let textBytes = 0;

	const handle = (raw: string) => {
		let message: RgLine;
		try {
			message = JSON.parse(raw) as RgLine;
		} catch {
			return;
		}
		const data = message.data;
		if (!data || data.line_number === undefined) {
			return;
		}
		const fullText = stripNewline(data.lines?.text ?? "");
		textBytes += Buffer.byteLength(fullText, "utf8");
		if (textBytes > MAX_TEXT_BYTES) {
			truncated = true;
			stop();
			return;
		}
		const text = fullText.slice(0, MAX_LINE_CHARS);
		if (message.type === "context") {
			const last = matches.at(-1);
			if (last && data.line_number === last.line + 1 && last.after.length === 0) {
				last.after.push(text);
				return;
			}
			pendingBefore = { line: data.line_number, text };
			return;
		}
		if (message.type !== "match") {
			return;
		}
		// rg reports a path that is not valid UTF-8 as bytes only; without a
		// text path there is nothing safe to return.
		const pathText = data.path?.text;
		if (pathText === undefined) {
			pendingBefore = undefined;
			return;
		}
		const relativePath = relative(project.path, pathText);
		if (
			relativePath === "" ||
			isAbsolute(relativePath) ||
			relativePath.startsWith("..")
		) {
			pendingBefore = undefined;
			return;
		}
		const before =
			pendingBefore && pendingBefore.line === data.line_number - 1
				? [pendingBefore.text]
				: [];
		pendingBefore = undefined;
		matches.push({
			path: relativePath,
			line: data.line_number,
			column: (data.submatches?.[0]?.start ?? 0) + 1,
			text,
			before,
			after: [],
		});
		if (matches.length >= MAX_SEARCH_MATCHES) {
			truncated = true;
			stop();
		}
	};

	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.length > 0) {
				handle(line);
			}
			index = buffer.indexOf("\n");
		}
	});
	// Drain stderr so a noisy run cannot fill the pipe and stall ripgrep.
	child.stderr?.resume();

	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (exitCode) => resolve(exitCode));
		});
		// 0 means matches, 1 means none; anything else is a real failure.
		if (!stopped && code !== 0 && code !== 1) {
			throw new AgentFailure("SEARCH_FAILED", "search failed");
		}
	} catch (error) {
		if (error instanceof AgentFailure) {
			throw error;
		}
		throw new AgentFailure("SEARCH_FAILED", "search could not be started");
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}

	return { matches: matches.slice(0, MAX_SEARCH_MATCHES), truncated };
}

function stripNewline(text: string): string {
	return text.replace(/\r?\n$/, "");
}
