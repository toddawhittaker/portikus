/**
 * Deriving a project name from a clone URL, and adding the `.git` suffix the
 * big hosts accept (SPEC.md §7.2, §7.6). Students paste a URL and should not
 * have to type the name again.
 */

// These four hosts serve a repository at both `<path>` and `<path>.git`, so
// adding the suffix is safe. Other hosts (Azure DevOps, some self-hosted
// servers) refuse it, so their URLs are sent exactly as typed.
const SUFFIX_HOSTS = new Set([
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"codeberg.org",
]);

/**
 * The repository name in a clone URL: the last path segment with any `.git`
 * removed. Returns an empty string when there is nothing usable.
 */
export function projectNameFromCloneUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed === "") return "";
	// Drop a query or fragment, then any trailing slashes.
	const path = trimmed.split(/[?#]/)[0]?.replace(/\/+$/, "") ?? "";
	const segment = path.split(/[/:]/).pop() ?? "";
	return segment.replace(/\.git$/i, "");
}

/**
 * The URL to send to the API: unchanged, except that an https URL on a host
 * known to accept it gets the missing `.git` suffix.
 */
export function cloneUrlForRequest(url: string): string {
	const trimmed = url.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed;
	}
	if (parsed.protocol !== "https:") return trimmed;
	if (!SUFFIX_HOSTS.has(parsed.hostname.toLowerCase())) return trimmed;
	const path = parsed.pathname.replace(/\/+$/, "");
	// Only a real repository path gets the suffix: /owner/repo.
	if (path.split("/").filter(Boolean).length !== 2) return trimmed;
	if (/\.git$/i.test(path)) return trimmed;
	parsed.pathname = `${path}.git`;
	return parsed.toString();
}
