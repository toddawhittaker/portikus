import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { GUIDE_FILES } from "./guides.js";

// The build copies the guides the assistant reads into the package beside the
// API (SPEC.md section 20.5). The loader's file list and the build's must be
// the same, or the assistant would search guides the package does not carry.

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

test("the build copies exactly the guides the assistant reads, and each exists", () => {
	const script = readFileSync(`${ROOT}scripts/build-deb.sh`, "utf8");
	const line = /^guides=\(([^)]*)\)$/m.exec(script);
	expect(line, "build-deb.sh has no guides=(...) line").not.toBeNull();
	expect(line?.[1]?.trim().split(/\s+/)).toEqual([...GUIDE_FILES]);
	for (const file of GUIDE_FILES) {
		expect(existsSync(`${ROOT}docs/${file}`), file).toBe(true);
	}
});

test("the package carries them in the API's tree, which nfpm installs whole", () => {
	const config = readFileSync(`${ROOT}packaging/nfpm.yaml`, "utf8");
	expect(config).toMatch(
		/src: \.\/dist\/deploy\/api\n\s+dst: \/usr\/lib\/portikus\/api\n\s+type: tree/,
	);
	const script = readFileSync(`${ROOT}scripts/build-deb.sh`, "utf8");
	expect(script).toContain("dist/deploy/api/guides");
	expect(script).toContain("./usr/lib/portikus/api/guides/$guide");
});
