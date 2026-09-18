import { z } from "zod";
import { TerminalId } from "./terminal.js";

/**
 * A project slug names the directory under `~/projects` (SPEC.md §7.1).
 * Lowercase letters, digits and hyphens, starting with a letter or digit,
 * and at most 63 characters so it also fits a DNS label.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const ProjectSlug = z.string().regex(PROJECT_SLUG_PATTERN);
export type ProjectSlug = z.infer<typeof ProjectSlug>;

/** Longest project name a student may enter (SPEC.md §7.2). */
export const MAX_PROJECT_NAME_LENGTH = 80;

/**
 * Derive a slug from a project name. Shared by the API and the web app so
 * the create dialog can preview the directory before it exists.
 * Returns "" when the name has no usable characters; callers decide what
 * to tell the user.
 */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
	return slug;
}

/** Active or archived (SPEC.md §7.4). */
export const ProjectState = z.enum(["active", "archived"]);
export type ProjectState = z.infer<typeof ProjectState>;

/** How the project came to exist (SPEC.md §7.2; discovered comes from `~/projects`). */
export const ProjectSource = z.enum(["new", "clone", "template", "discovered"]);
export type ProjectSource = z.infer<typeof ProjectSource>;

/**
 * A project as the control plane knows it (SPEC.md §7, §26).
 * `isGitRepo` and `missing` are null when the workspace is not running and
 * the agent could not be asked.
 */
export const Project = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	slug: ProjectSlug,
	name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH),
	path: z.string().min(1),
	state: ProjectState,
	source: ProjectSource,
	isGitRepo: z.boolean().nullable(),
	missing: z.boolean().nullable(),
	createdAt: z.string().datetime(),
	archivedAt: z.string().datetime().nullable(),
});
export type Project = z.infer<typeof Project>;

/** Response body for `GET /workspaces/:id/projects` (SPEC.md §26). */
export const ProjectList = z.object({
	projects: z.array(Project),
});
export type ProjectList = z.infer<typeof ProjectList>;

const SCP_LIKE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:.+$/;

/** Written as a loop rather than a regular expression so the control characters stay readable. */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Whether a scheme-based URL carries credentials. A secret in a clone URL
 * ends up in logs and in `.git/config`, so it is refused (SPEC.md §24.8).
 * A bare `git@` on an ssh URL is the ordinary way to name the remote account
 * and carries no secret, so it stays allowed; on http and https any userinfo
 * is a token or a password.
 */
function hasCredentials(value: string, scheme: string): boolean {
	const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
	const at = authority.lastIndexOf("@");
	if (at < 0) return false;
	return scheme === "ssh" ? authority.slice(0, at).includes(":") : true;
}

/**
 * A Git URL the platform is willing to clone (SPEC.md §7.2, §24).
 * Only https, http, ssh and the scp-like `user@host:path` form are allowed;
 * everything else, including `file://` and Git's `ext::` transport, can
 * reach the local filesystem or run a command and is refused.
 */
export const CloneUrl = z
	.string()
	.min(1)
	.max(2048)
	.refine((value) => {
		if (hasControlCharacter(value)) return false;
		if (/\s/.test(value)) return false;
		// A leading hyphen would be read as an option by git.
		if (value.startsWith("-")) return false;
		const scheme = /^(https?|ssh):\/\/[^/]/.exec(value)?.[1];
		if (scheme) return !hasCredentials(value, scheme);
		return SCP_LIKE.test(value);
	}, "must be an http, https, ssh or user@host:path Git URL without credentials");
export type CloneUrl = z.infer<typeof CloneUrl>;

/** One configured project template (SPEC.md §7.2). */
export const ProjectTemplate = z.object({
	name: z.string().min(1),
	url: CloneUrl,
});
export type ProjectTemplate = z.infer<typeof ProjectTemplate>;

/** Response body for `GET /workspaces/:id/projects/templates`. */
export const ProjectTemplateList = z.object({
	templates: z.array(ProjectTemplate),
});
export type ProjectTemplateList = z.infer<typeof ProjectTemplateList>;

/**
 * Parse the `PROJECT_TEMPLATES` environment variable, which is
 * `name=url,name=url`. Empty entries are skipped; a malformed entry is an
 * error so a typo does not silently drop a template.
 */
export function parseProjectTemplates(env: string): ProjectTemplate[] {
	const templates: ProjectTemplate[] = [];
	for (const raw of env.split(",")) {
		const entry = raw.trim();
		if (entry === "") continue;
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new Error(`Invalid project template entry: ${entry}`);
		}
		const name = entry.slice(0, separator).trim();
		const url = entry.slice(separator + 1).trim();
		const parsed = ProjectTemplate.safeParse({ name, url });
		if (!parsed.success) {
			throw new Error(`Invalid project template entry: ${entry}`);
		}
		templates.push(parsed.data);
	}
	return templates;
}

/**
 * Request body for `POST /workspaces/:id/projects` (SPEC.md §7.2).
 * Git is initialized by default for a new project.
 */
export const CreateProjectRequest = z
	.object({
		name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH),
		source: z.enum(["new", "clone", "template"]),
		url: CloneUrl.optional(),
		template: z.string().min(1).optional(),
		gitInit: z.boolean().default(true),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.source === "clone" && value.url === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "url is required when source is clone",
			});
		}
		if (value.source === "template" && value.template === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["template"],
				message: "template is required when source is template",
			});
		}
		if (
			value.source === "new" &&
			(value.url !== undefined || value.template !== undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["source"],
				message: "url and template are not allowed when source is new",
			});
		}
	});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/**
 * Request body for `DELETE /workspaces/:id/projects/:projectId`
 * (SPEC.md §7.3). Deleting is permanent, so the student types the slug
 * back and the API refuses anything else.
 */
export const DeleteProjectRequest = z
	.object({
		slug: ProjectSlug,
	})
	.strict();
export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequest>;

/**
 * Request body for `PATCH /workspaces/:id/projects/:projectId`
 * (SPEC.md §7.3, §7.4). A name change renames the slug and the directory.
 */
export const UpdateProjectRequest = z
	.object({
		name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH).optional(),
		state: ProjectState.optional(),
	})
	.strict()
	.refine(
		(value) => value.name !== undefined || value.state !== undefined,
		"at least one of name or state is required",
	);
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/** Request body for `POST /workspaces/:id/projects/:projectId/duplicate`. */
export const DuplicateProjectRequest = z
	.object({
		name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH),
	})
	.strict();
export type DuplicateProjectRequest = z.infer<typeof DuplicateProjectRequest>;

/**
 * One node of a saved split layout (SPEC.md §7.5, §9.3). A leaf is one
 * terminal; a split has at least two children and one size per child.
 */
export type SplitNode =
	| { type: "leaf"; terminalId: string }
	| {
			type: "split";
			direction: "row" | "column";
			sizes: number[];
			children: SplitNode[];
	  };

export const SplitNode: z.ZodType<SplitNode> = z.lazy(() =>
	z.union([
		z.object({ type: z.literal("leaf"), terminalId: TerminalId }).strict(),
		z
			.object({
				type: z.literal("split"),
				direction: z.enum(["row", "column"]),
				sizes: z.array(z.number()),
				children: z.array(SplitNode).min(2),
			})
			.strict()
			.refine(
				(node) => node.sizes.length === node.children.length,
				"sizes must have one entry per child",
			),
	]),
);

/** Most tabs one project may save. Well past what fits on a screen. */
export const MAX_LAYOUT_TABS = 16;

/** Most nodes on any one path from a tab's root to a leaf. */
export const MAX_SPLIT_DEPTH = 8;

/** The deepest path from this node to a leaf, counting this node. */
export function splitDepth(node: SplitNode): number {
	if (node.type === "leaf") return 1;
	let deepest = 0;
	for (const child of node.children) {
		deepest = Math.max(deepest, splitDepth(child));
	}
	return deepest + 1;
}

/**
 * The saved layout of one project (SPEC.md §7.5). The browser writes this
 * column, so its size is bounded here: the whole tree is otherwise
 * attacker-controlled JSON the API stores and hands back.
 */
export const ProjectLayout = z.object({
	tabs: z
		.array(
			z.object({
				id: z.string().min(1).max(64),
				root: SplitNode,
			}),
		)
		.max(MAX_LAYOUT_TABS)
		.superRefine((tabs, ctx) => {
			const seen = new Set<string>();
			tabs.forEach((tab, index) => {
				// Two tabs with one id render on top of each other in the browser.
				if (seen.has(tab.id)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "id"],
						message: "tab ids must be unique",
					});
				}
				seen.add(tab.id);
				if (splitDepth(tab.root) > MAX_SPLIT_DEPTH) {
					ctx.addIssue({
						code: "custom",
						path: [index, "root"],
						message: `a split may be at most ${MAX_SPLIT_DEPTH} levels deep`,
					});
				}
			});
		}),
});
export type ProjectLayout = z.infer<typeof ProjectLayout>;
