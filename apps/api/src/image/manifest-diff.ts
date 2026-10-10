import type { ImageDiff, ImageManifest } from "@portikus/contracts";

type DiffPart = ImageDiff["packages"];

/** Compare two name-to-version maps; a null version counts as absent. */
function diffMaps(
	from: Record<string, string | null | undefined>,
	to: Record<string, string | null | undefined>,
	names = [...new Set([...Object.keys(from), ...Object.keys(to)])],
): DiffPart {
	const part: DiffPart = { added: [], removed: [], changed: [] };
	names.sort();
	for (const name of names) {
		const before = from[name] ?? null;
		const after = to[name] ?? null;
		if (before === null && after !== null) part.added.push({ name, version: after });
		else if (before !== null && after === null)
			part.removed.push({ name, version: before });
		else if (before !== after) part.changed.push({ name, from: before, to: after });
	}
	return part;
}

/**
 * What `to` adds, removes and changes against `from`, for packages and for
 * the named tools (docs/SPEC.md section 22.4). Names come out sorted.
 */
export function diffManifests(from: ImageManifest, to: ImageManifest): ImageDiff {
	return {
		from: from.version,
		to: to.version,
		// Only tools both manifests name: newer ones leave out the shared-folder coding agents.
		tools: diffMaps(
			from.tools,
			to.tools,
			Object.keys(from.tools).filter((name) => name in to.tools),
		),
		packages: diffMaps(from.packages, to.packages),
	};
}
