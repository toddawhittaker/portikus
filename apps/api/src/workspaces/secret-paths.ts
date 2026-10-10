import type { GitStatus, TreeResponse } from "@portikus/contracts";

/**
 * The secret filter on a shared project (SPEC.md §5.2, ADR 0057). It is a
 * deny list by name, so a secret under another name stays visible.
 */

/** Whole names that are never shown, compared without case. */
const SECRET_NAMES = new Set([".git", ".npmrc", ".netrc", ".pypirc", ".portikus"]);

/** True when one path segment names a secret. */
function isSecretName(segment: string): boolean {
	const name = segment.toLowerCase();
	if (SECRET_NAMES.has(name)) return true;
	if (name === ".env.example") return false;
	if (name === ".env" || name.startsWith(".env.")) return true;
	if (name.endsWith(".pem") || name.endsWith(".key")) return true;
	return name.startsWith("id_rsa") || name.startsWith("id_ed25519");
}

/** True when any segment of a project-relative path names a secret. */
export function isSecretPath(path: string): boolean {
	return path
		.split("/")
		.filter((segment) => segment !== "")
		.some(isSecretName);
}

/** A listing of `dir` without its secret entries. */
export function filterTree(dir: string, tree: TreeResponse): TreeResponse {
	return {
		...tree,
		entries: tree.entries.filter(
			(entry) => !isSecretPath(dir === "" ? entry.name : `${dir}/${entry.name}`),
		),
	};
}

/** Git status without any entry that names a secret, before or after a rename. */
export function filterGitStatus(status: GitStatus): GitStatus {
	return {
		...status,
		entries: status.entries.filter(
			(entry) =>
				!isSecretPath(entry.path) &&
				(entry.origPath === undefined || !isSecretPath(entry.origPath)),
		),
		ignored: status.ignored.filter((path) => !isSecretPath(path)),
	};
}
