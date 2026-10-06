/**
 * The control-plane UI's content security policy (SPEC.md section 24.3),
 * written into index.html as a meta tag at build time so the dev server the
 * Playwright suite drives serves the same policy as the package.
 *
 * Only the build reads this module; nothing in the bundle imports it.
 */
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * The directives, with the reason each source is there.
 *
 * - script-src: only files from this origin. Inline scripts get a hash only
 *   when index.html holds one, which the production build does not.
 * - style-src 'unsafe-inline': Monaco and xterm add `<style>` elements at
 *   run time, and the dev server injects CSS the same way. Styles cannot run
 *   script, so this does not weaken the script rule.
 * - img-src https:: a student's README shows its badges and remote images.
 *   data: and blob: are the SVG viewer and pasted images.
 * - connect-src and frame-src https:: a preview is its own host under a
 *   suffix chosen at install time (SPEC.md section 14.3), so the build cannot
 *   name it; the page frames it and asks it to clear its data. blob: in
 *   frame-src is the PDF viewer. Only this origin's scripts can run, so these
 *   only bound where our own code reaches.
 * - frame-ancestors is not allowed in a meta tag; Caddy sends it.
 */
const DIRECTIVES: Record<string, readonly string[]> = {
	"default-src": ["'self'"],
	"script-src": ["'self'"],
	"style-src": ["'self'", "'unsafe-inline'"],
	"img-src": ["'self'", "data:", "blob:", "https:"],
	"font-src": ["'self'"],
	"connect-src": ["'self'", "https:"],
	"frame-src": ["'self'", "blob:", "https:"],
	"worker-src": ["'self'"],
	"object-src": ["'none'"],
	"base-uri": ["'self'"],
	"form-action": ["'self'"],
};

/** The policy, with a hash added to script-src for each inline script given. */
export function contentSecurityPolicy(inlineScripts: readonly string[] = []): string {
	const hashes = inlineScripts.map(
		(body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
	);
	return Object.entries(DIRECTIVES)
		.map(([name, sources]) =>
			[name, ...sources, ...(name === "script-src" ? hashes : [])].join(" "),
		)
		.join("; ");
}

const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** Puts the policy first in `<head>`, so it covers every element after it. */
export function withContentSecurityPolicy(html: string): string {
	const inline = [...html.matchAll(INLINE_SCRIPT)].map((match) => match[1] ?? "");
	const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(inline)}" />`;
	return html.replace(/<head>/i, `<head>\n    ${meta}`);
}

/**
 * Runs last, after every other plugin has added its tags, so the dev
 * server's React refresh preamble is seen and hashed.
 */
export function contentSecurityPolicyPlugin(): Plugin {
	return {
		name: "portikus-content-security-policy",
		transformIndexHtml: { order: "post", handler: withContentSecurityPolicy },
	};
}
