import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// `scripts/build-deb.sh` deletes `dist/security` from the package (STACK.md
// section 22, the .deb): it holds only tests and their helpers. A runtime
// module that imports from there installs fine and then crashes at start with
// ERR_MODULE_NOT_FOUND, so this fails first. Move the shared module up a level.

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SECURITY = join(SRC, "security");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (path === SECURITY) return [];
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

test("no module the package ships imports from the security folder", () => {
	const fromSecurity =
		/\bfrom\s+"(?:\.{1,2}\/)+(?:[\w-]+\/)*security\/|\bimport\(\s*"(?:\.{1,2}\/)+(?:[\w-]+\/)*security\//;
	const offenders = sourceFiles(SRC).filter((file) =>
		fromSecurity.test(readFileSync(file, "utf8")),
	);
	expect(offenders).toEqual([]);
});
