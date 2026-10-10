import { createHash, randomBytes } from "node:crypto";
import type { LtiDeepLinkingLaunch } from "@portikus/auth";
import { MAX_PROJECT_NAME_LENGTH, type ProjectTemplate } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely, Selectable } from "kysely";
import { escapeHtml } from "../http.js";
import type { StarterProblem } from "./starter.js";

/** How long a picker page stays usable (ADR 0058). */
const DEEP_LINK_REQUEST_LIFETIME_MS = 10 * 60 * 1000;

export type DeepLinkRequestRow = Selectable<Database["lti_deep_link_requests"]>;

function hashHandle(handle: string): string {
	return createHash("sha256").update(handle).digest("hex");
}

/**
 * Keep a valid Deep Linking request until the instructor picks, and return
 * the handle the picker form carries. Only the handle's hash is stored.
 */
export async function saveDeepLinkRequest(
	db: Kysely<Database>,
	launch: LtiDeepLinkingLaunch,
	now = new Date(),
): Promise<string> {
	await db
		.deleteFrom("lti_deep_link_requests")
		.where("expires_at", "<=", now)
		.execute();
	const handle = randomBytes(32).toString("base64url");
	await db
		.insertInto("lti_deep_link_requests")
		.values({
			state_hash: hashHandle(handle),
			platform_issuer: launch.platform.issuer,
			subject: launch.subject,
			client_id: launch.platform.clientId,
			deployment_id: launch.deploymentId,
			return_url: launch.deepLinkReturnUrl,
			data: launch.deepLinkData,
			expires_at: new Date(now.getTime() + DEEP_LINK_REQUEST_LIFETIME_MS).toISOString(),
		})
		.execute();
	return handle;
}

/** The unexpired request a handle names, left in place. */
export function findDeepLinkRequest(
	db: Kysely<Database>,
	handle: string,
	now = new Date(),
): Promise<DeepLinkRequestRow | undefined> {
	return db
		.selectFrom("lti_deep_link_requests")
		.selectAll()
		.where("state_hash", "=", hashHandle(handle))
		.where("expires_at", ">", now)
		.executeTakeFirst();
}

/** Take the unexpired request a handle names; deleting it makes the handle single use. */
export function takeDeepLinkRequest(
	db: Kysely<Database>,
	handle: string,
	now = new Date(),
): Promise<DeepLinkRequestRow | undefined> {
	return db
		.deleteFrom("lti_deep_link_requests")
		.where("state_hash", "=", hashHandle(handle))
		.where("expires_at", ">", now)
		.returningAll()
		.executeTakeFirst();
}

/**
 * A server-rendered page with no script, in the design tokens' colours,
 * light and dark, for the picker and the return step. A page showing an
 * error says so first in its title, which is read before anything else.
 */
export function deepLinkPage(heading: string, body: string, error = false): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${error ? "Error: " : ""}${escapeHtml(heading)} - Portikus</title>
<style>
:root { color-scheme: light dark; --surface: #f6f4ef; --raised: #fdfcfa; --line: #dcd7cc; --ink: #23211d; --muted: #5a554c; --accent: #2c6a66; --accent-hover: #22524f; --on-accent: #ffffff; --danger: #a3341f; }
@media (prefers-color-scheme: dark) { :root { --surface: #171614; --raised: #211f1c; --line: #35322d; --ink: #ece8df; --muted: #aba498; --accent: #7cc2b9; --accent-hover: #9bd3cb; --on-accent: #0f201e; --danger: #f0a08f; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--surface); color: var(--ink); font: 16px/1.5 "Public Sans", system-ui, sans-serif; }
main { max-width: 36rem; margin: 1.5rem; padding: 1.5rem; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; }
h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
p { margin: 0 0 0.75rem; color: var(--muted); overflow-wrap: anywhere; }
.error { color: var(--danger); font-weight: 600; }
form { margin-top: 1rem; display: grid; gap: 0.5rem; }
fieldset { margin: 0 0 0.5rem; padding: 0.75rem; border: 1px solid var(--line); border-radius: 6px; }
legend { font-weight: 600; padding: 0 0.25rem; }
.choice { display: flex; gap: 0.5rem; align-items: center; padding: 0.25rem 0; }
label { font-weight: 600; }
.choice label { font-weight: 400; }
input[type="text"], input[type="url"] { font: inherit; padding: 0.4rem 0.5rem; border: 1px solid var(--muted); border-radius: 6px; background: var(--surface); color: var(--ink); }
.hint { font-size: 0.875rem; margin: 0 0 0.5rem; }
button { justify-self: start; font: inherit; font-weight: 600; padding: 0.5rem 1rem; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button:hover { background: var(--accent-hover); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
${body}</main>
</body>
</html>
`;
}

const PROBLEMS: Record<StarterProblem, string> = {
	source: "Choose a template, or choose a repository and enter its URL.",
	template: "That template is no longer offered. Choose another.",
	repository:
		"The repository URL must be a public https URL with no user name or password, like https://github.com/owner/repository.git.",
	name: `The project name needs a letter or a digit, and at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
};

/** What the instructor entered, kept when the picker is shown again. */
export interface PickerValues {
	choice: string;
	repositoryUrl: string;
	projectName: string;
}

/** The picker's radio value for a template; the repository's is `repository`. */
export function templateChoice(name: string): string {
	return `template:${name}`;
}

/** The picker: a template or a public repository, and a project name. */
export function pickerPage(
	handle: string,
	templates: readonly ProjectTemplate[],
	values: PickerValues | null = null,
	problem: StarterProblem | null = null,
): string {
	const choices = [
		...templates.map((t) => ({
			value: templateChoice(t.name),
			label: `Template: ${t.name}`,
		})),
		{ value: "repository", label: "A public Git repository" },
	];
	const chosen = values?.choice ?? choices[0]?.value;
	const radios = choices
		.map(
			(c, i) =>
				`<div class="choice"><input type="radio" id="choice-${i}" name="choice" value="${escapeHtml(c.value)}"${c.value === chosen ? " checked" : ""}><label for="choice-${i}">${escapeHtml(c.label)}</label></div>`,
		)
		.join("\n");
	const error = problem
		? `<p class="error" id="picker-error">${escapeHtml(PROBLEMS[problem])}</p>\n`
		: "";
	// The field the error names is marked invalid and points at the error.
	const field = problem === "template" ? "source" : problem;
	const invalid = (name: StarterProblem) =>
		field === name ? ' aria-invalid="true"' : "";
	const describedBy = (name: StarterProblem, hint: string) =>
		field === name ? `picker-error ${hint}` : hint;
	const sourceError =
		field === "source" ? ' aria-invalid="true" aria-describedby="picker-error"' : "";
	const body = `<p>Students who open this link get the project in their Portikus workspace. A project they already have is opened as it is, never overwritten.</p>
${error}<form method="post" action="/lti/deep-link">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset${sourceError}>
<legend>Start from</legend>
${radios}
</fieldset>
<label for="repository">Repository URL</label>
<p class="hint" id="repository-hint">Only when you chose a repository. A public https URL, not ssh.</p>
<input type="url" id="repository" name="repository"${invalid("repository")} aria-describedby="${describedBy("repository", "repository-hint")}" value="${escapeHtml(values?.repositoryUrl ?? "")}">
<label for="project">Project name</label>
<p class="hint" id="project-hint">Leave it blank to use the template's name or the repository's folder name.</p>
<input type="text" id="project" name="project" maxlength="${MAX_PROJECT_NAME_LENGTH}"${invalid("name")} aria-describedby="${describedBy("name", "project-hint")}" value="${escapeHtml(values?.projectName ?? "")}">
<button type="submit">Add the link</button>
</form>
`;
	return deepLinkPage("Choose what this link opens", body, problem !== null);
}

/** The return step: a button, never an auto-submitting script, posts the signed response. */
export function returnPage(
	returnUrl: string,
	jwt: string,
	projectName: string,
): string {
	const body = `<p>The link to “${escapeHtml(projectName)}” is ready. Return to your course to finish adding it.</p>
<form method="post" action="${escapeHtml(returnUrl)}">
<input type="hidden" name="JWT" value="${escapeHtml(jwt)}">
<button type="submit">Return to your course</button>
</form>
`;
	return deepLinkPage("Link ready", body);
}

/** A picker whose handle is gone or expired. */
export function expiredPage(): string {
	return deepLinkPage(
		"This page has expired",
		"<p>Choosing what a link opens must finish within ten minutes, once. Start again from your course.</p>\n",
	);
}
