import type { ImageManifest } from "@portikus/contracts";
import { expect, test } from "vitest";
import { diffManifests } from "./manifest-diff.js";

function manifest(over: Partial<ImageManifest> = {}): ImageManifest {
	return {
		schema: 1,
		version: "2026.09.9",
		recipeVersion: "2026.09.9",
		source: "published",
		builtAt: "2026-09-20T10:00:00Z",
		fingerprint: null,
		parameters: { node: "24", python: "debian" },
		tools: {
			node: "v24.8.0",
			npm: "11.6.0",
			python3: "Python 3.13.5",
			git: "git version 2.47.3",
			docker: "Docker version 28.4.0",
			claude: "2.0.1",
			codex: "0.40.0",
		},
		packages: { curl: "8.14.1-2", git: "1:2.47.3-0", vim: "2:9.1.1230-2" },
		...over,
	};
}

test("identical manifests differ in nothing", () => {
	const diff = diffManifests(manifest(), manifest({ version: "2026.09.10" }));
	expect(diff).toEqual({
		from: "2026.09.9",
		to: "2026.09.10",
		tools: { added: [], removed: [], changed: [] },
		packages: { added: [], removed: [], changed: [] },
	});
});

test("packages added, removed and changed are listed by name, sorted", () => {
	const to = manifest({
		version: "2026.09.9-local.202609281530",
		packages: { zsh: "5.9-8", curl: "8.14.1-3", git: "1:2.47.3-0", apt: "3.0.3" },
	});
	const diff = diffManifests(manifest(), to);
	expect(diff.packages).toEqual({
		added: [
			{ name: "apt", version: "3.0.3" },
			{ name: "zsh", version: "5.9-8" },
		],
		removed: [{ name: "vim", version: "2:9.1.1230-2" }],
		changed: [{ name: "curl", from: "8.14.1-2", to: "8.14.1-3" }],
	});
});

test("a tool that appears or goes missing is added or removed; a new version is changed", () => {
	const from = manifest({ tools: { ...manifest().tools, codex: null } });
	const to = manifest({
		tools: { ...manifest().tools, node: "v26.0.0", claude: null, codex: "0.41.0" },
	});
	expect(diffManifests(from, to).tools).toEqual({
		added: [{ name: "codex", version: "0.41.0" }],
		removed: [{ name: "claude", version: "2.0.1" }],
		changed: [{ name: "node", from: "v24.8.0", to: "v26.0.0" }],
	});
});

test("claude and codex missing from one side are not reported as removed or added", () => {
	const { claude: _c, codex: _x, ...newer } = manifest().tools;
	const older = manifest();
	const without = manifest({ version: "2026.10.2", tools: newer });
	expect(diffManifests(older, without).tools).toEqual({
		added: [],
		removed: [],
		changed: [],
	});
	expect(diffManifests(without, older).tools).toEqual({
		added: [],
		removed: [],
		changed: [],
	});
});
