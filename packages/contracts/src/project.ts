import { z } from "zod";
import { ProjectPath } from "./files.js";
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

/**
 * The display name of a project discovered on disk, or of one whose folder
 * the student renamed in a shell. Words are split on hyphens
 * and underscores and capitalised, so `project-name` reads `Project Name`.
 * A directory name with nothing to capitalise is used as it stands.
 */
export function displayNameFromDirectory(directory: string): string {
	const words = directory.split(/[-_]+/).filter((word) => word !== "");
	const name = words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")
		.slice(0, MAX_PROJECT_NAME_LENGTH)
		.trim();
	return name === "" ? directory : name;
}

/** Cut a name to the length limit, at a word break when there is one. */
function trimName(name: string): string {
	if (name.length <= MAX_PROJECT_NAME_LENGTH) return name;
	const cut = name.slice(0, MAX_PROJECT_NAME_LENGTH + 1);
	const space = cut.lastIndexOf(" ");
	return (
		space > 0 ? cut.slice(0, space) : cut.slice(0, MAX_PROJECT_NAME_LENGTH)
	).trim();
}

/** The first Markdown heading's text, with its formatting removed. */
function readmeHeading(markdown: string): string | undefined {
	let fenced = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^\s{0,3}(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const match = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
		if (!match) continue;
		const text = (match[1] ?? "")
			.replace(/\s+#+\s*$/, "")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/<[^>]*>/g, "")
			.replace(/[*_`~]+/g, "")
			// Emoji decorate a heading but make a poor project name.
			.replace(
				/(?![\u{A9}\u{AE}\u{2122}])\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}/gu,
				"",
			)
			.replace(/\s+/g, " ")
			.trim();
		if (text !== "") return text;
	}
	return undefined;
}

/** `displayName`, else a readable `name`, from package.json text. */
function packageJsonName(text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { displayName, name } = parsed as { displayName?: unknown; name?: unknown };
	if (typeof displayName === "string" && displayName.trim() !== "") {
		return displayName.trim();
	}
	if (typeof name === "string" && name.trim() !== "") {
		// A scoped npm name keeps only its package part.
		return displayNameFromDirectory(name.trim().replace(/^@[^/]+\//, ""));
	}
	return undefined;
}

/** The `name` under `[project]` or `[tool.poetry]` in pyproject.toml text. */
function pyprojectName(text: string): string | undefined {
	let section = "";
	for (const line of text.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header) {
			section = (header[1] ?? "").trim();
			continue;
		}
		if (section !== "project" && section !== "tool.poetry") continue;
		const value = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line);
		if (value?.[1]) return displayNameFromDirectory(value[1].trim());
	}
	return undefined;
}

/**
 * The name a cloned repository gives itself: the README's first
 * heading, else package.json, else pyproject.toml. Undefined when none of
 * them names it, so the caller falls back to the folder name.
 */
export function projectNameFromRepository(files: {
	readme?: string;
	packageJson?: string;
	pyproject?: string;
}): string | undefined {
	const name =
		(files.readme === undefined ? undefined : readmeHeading(files.readme)) ??
		(files.packageJson === undefined
			? undefined
			: packageJsonName(files.packageJson)) ??
		(files.pyproject === undefined ? undefined : pyprojectName(files.pyproject));
	return name === undefined ? undefined : trimName(name);
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
		/** Clone only: store the name the repository gives itself, if any. */
		nameFromRepository: z.boolean().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.nameFromRepository !== undefined && value.source !== "clone") {
			ctx.addIssue({
				code: "custom",
				path: ["nameFromRepository"],
				message: "nameFromRepository is only allowed when source is clone",
			});
		}
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
	| { type: "file"; path: string }
	| { type: "diff"; path: string }
	| { type: "preview"; port: number }
	| {
			type: "split";
			direction: "row" | "column";
			sizes: number[];
			children: SplitNode[];
	  };

export const SplitNode: z.ZodType<SplitNode> = z.lazy(() =>
	z.union([
		z.object({ type: z.literal("leaf"), terminalId: TerminalId }).strict(),
		z.object({ type: z.literal("file"), path: ProjectPath }).strict(),
		z.object({ type: z.literal("diff"), path: ProjectPath }).strict(),
		z
			.object({ type: z.literal("preview"), port: z.number().int().min(1).max(65535) })
			.strict(),
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

/** Most nodes on any one path from a tab's root to a leaf. */
export const MAX_SPLIT_DEPTH = 8;

/** The deepest path from this node to a leaf, counting this node. */
export function splitDepth(node: SplitNode): number {
	if (node.type !== "split") return 1;
	let deepest = 0;
	for (const child of node.children) {
		deepest = Math.max(deepest, splitDepth(child));
	}
	return deepest + 1;
}

/**
 * True when a file, diff or preview node sits anywhere below the root of a
 * tab. Only terminals split (SPEC.md §8.3), so those are always whole tabs.
 */
function hasNestedDocument(node: SplitNode): boolean {
	if (node.type !== "split") return false;
	return node.children.some(
		(child) =>
			child.type === "file" ||
			child.type === "diff" ||
			child.type === "preview" ||
			hasNestedDocument(child),
	);
}

/**
 * The dedupe key of a tab whose root is a file, diff or preview, or null for
 * a tab of terminals. The browser uses the same string as the tab id.
 */
export function documentTabId(node: SplitNode): string | null {
	if (node.type === "file") return `file:${node.path}`;
	if (node.type === "diff") return `diff:${node.path}`;
	if (node.type === "preview") return `preview:${node.port}`;
	return null;
}

/**
 * Most layout bytes one user may keep across all their projects, so many
 * workspaces and projects cannot fill the database (SPEC.md §7.5).
 */
export const MAX_LAYOUT_BYTES_PER_USER = 8 * 1024 * 1024;

/**
 * The saved layout of one project (SPEC.md §7.5). There is no cap on the
 * number of tabs: the strip shrinks and then scrolls instead.
 * The browser writes this column and the whole tree is attacker-controlled
 * JSON the API stores and hands back, so its size is still bounded, by
 * Fastify's 1 MiB body limit on the request that saves it and by the length
 * and shape limits on each tab below.
 */
export const ProjectLayout = z.object({
	tabs: z
		.array(
			z.object({
				// Long enough for a file or diff tab id, which is a kind prefix
				// and a project path.
				id: z.string().min(1).max(1_100),
				root: SplitNode,
			}),
		)
		.superRefine((tabs, ctx) => {
			const seen = new Set<string>();
			const documents = new Set<string>();
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
				if (hasNestedDocument(tab.root)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "root"],
						message: "only terminals may be split",
					});
				}
				const document = documentTabId(tab.root);
				if (document === null) {
					// A terminal tab id is a terminal id or a made-up name.
					if (tab.id.length > 64) {
						ctx.addIssue({
							code: "custom",
							path: [index, "id"],
							message: "a terminal tab id may be at most 64 characters",
						});
					}
				} else {
					// A document tab is found by its id, so it must match its path.
					if (tab.id !== document) {
						ctx.addIssue({
							code: "custom",
							path: [index, "id"],
							message: `a document tab id must be "${document}"`,
						});
					}
					// One tab per path per kind; two would edit the same file twice.
					if (documents.has(document)) {
						ctx.addIssue({
							code: "custom",
							path: [index, "root"],
							message: "a path or port may only be open once per tab kind",
						});
					}
					documents.add(document);
				}
			});
		}),
});
export type ProjectLayout = z.infer<typeof ProjectLayout>;
