import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// An async onSend hook, or an async handler that sends without returning
// the reply, lets Fastify answer one request twice: the client sees the
// first answer and the log gains a 500 and "Reply was already sent".
// Biome has no rule for either, so this scans the source.

const ROOTS = [
	".",
	"../../../packages/observability/src",
	"../../../packages/auth/src",
].map((dir) => fileURLToPath(new URL(dir, import.meta.url)));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

function offences(pattern: RegExp): string[] {
	return ROOTS.flatMap(sourceFiles).flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])),
	);
}

test("every reply.send is returned or awaited", () => {
	expect(offences(/^\s*reply\b[^;]*\.send\(/)).toEqual([]);
});

test("no onSend hook is async", () => {
	expect(offences(/addHook\(\s*"onSend",\s*async\b/)).toEqual([]);
});
