import { z } from "zod";

/**
 * The workspace image section and its root job (docs/EPIC-15.md rulings 22
 * to 29; ADR 0030). This comment is the contract the root job
 * (`packaging/image/image-job`) implements; the API side only reads what
 * the job writes, and writes nothing but one request file.
 *
 * Two directories on the host:
 *
 * - The job directory, `IMAGE_JOBS_DIR` (`/var/lib/portikus/image-jobs/`,
 *   root:portikus, 0770).
 *   - The API writes one request as `request-<id>.json`, where `<id>` is a
 *     lowercase UUID. It writes `.request-<id>.tmp` first and renames it,
 *     so the path unit (`PathExistsGlob=.../request-*.json`) never sees a
 *     half-written file. The body is `ImageJobRequestFile` below.
 *   - The job moves the request to `<id>/request.json` before doing
 *     anything, then writes `<id>/status.json` (`ImageJobStatusFile`) and
 *     `<id>/log.txt`, both group-readable by `portikus`. It rewrites
 *     status.json (write a temporary file, then rename) at each step.
 *   - A request that fails validation (unknown kind or choice, a version not
 *     matching `IMAGE_VERSION_PATTERN`, an unhealthy image to activate, a
 *     second job while one runs) still gets a `<id>/` with state `refused`
 *     and a message, when `<id>` is itself a UUID; otherwise it is only
 *     logged to the journal and deleted.
 *   - Only one job runs at a time. The API also refuses a new request while
 *     a `request-*.json` waits or any status says `running`.
 *
 * - The image store, `/var/lib/portikus/images/` (root, 0755), the sibling
 *   `images` of the job directory's parent. The API never writes here.
 *   - `aliases.json` (`ImageAliasesFile`): which version the Incus aliases
 *     `portikus` (default) and `portikus-previous` point at. Setup and the
 *     job rewrite it whenever they move an alias.
 *   - `<version>/manifest.json` (`ImageManifest`): what is in the image.
 *   - `<version>/health.json` (`ImageHealth`): the job's health check.
 *   - The image files themselves, which the API ignores.
 *
 * The job's kinds: `fetch` downloads and verifies a published image (the
 * newest when no version is given), imports it as `portikus-<version>`,
 * writes its manifest and health; `build` runs the recipe with the chosen
 * Node and Python, versions the result `<recipe VERSION>-local.<YYYYMMDDHHMM>`,
 * and does the same; `activate` moves `portikus` to a healthy version and
 * `portikus-previous` to the old default; `rollback` swaps the two. None of
 * them makes a new image the default on its own.
 */

/** A published version, or a local build's (ruling 24). The job enforces the same pattern. */
export const IMAGE_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d+(-local\.\d{12})?$/;

export const ImageVersion = z.string().regex(IMAGE_VERSION_PATTERN);
export type ImageVersion = z.infer<typeof ImageVersion>;

/** Node major from NodeSource (ruling 25). */
export const ImageNodeChoice = z.enum(["24", "26"]);
export type ImageNodeChoice = z.infer<typeof ImageNodeChoice>;

/** Debian's Python 3.13 alone, or with Python 3.14 from uv in /opt/python (ruling 25). */
export const ImagePythonChoice = z.enum(["debian", "uv-3.14"]);
export type ImagePythonChoice = z.infer<typeof ImagePythonChoice>;

export const ImageJobKind = z.enum(["fetch", "build", "activate", "rollback"]);
export type ImageJobKind = z.infer<typeof ImageJobKind>;

/** The body of `POST /admin/image/jobs`: nothing beyond the fixed kinds and choices. */
export const ImageJobRequest = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("fetch"), version: ImageVersion.optional() }).strict(),
	z
		.object({
			kind: z.literal("build"),
			node: ImageNodeChoice,
			python: ImagePythonChoice,
		})
		.strict(),
	z.object({ kind: z.literal("activate"), version: ImageVersion }).strict(),
	z.object({ kind: z.literal("rollback") }).strict(),
]);
export type ImageJobRequest = z.infer<typeof ImageJobRequest>;

export const ImageJobId = z.string().uuid();

/** `request-<id>.json` as the API writes it. */
export const ImageJobRequestFile = z.object({
	id: ImageJobId,
	/** ISO 8601 time the API wrote it. */
	requestedAt: z.string().datetime(),
	/** The administrator's user id, for the job's log. */
	requestedBy: z.string().uuid(),
	request: ImageJobRequest,
});
export type ImageJobRequestFile = z.infer<typeof ImageJobRequestFile>;

/** `queued` is the API's own name for a request file the job has not taken yet. */
export const ImageJobState = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"refused",
]);
export type ImageJobState = z.infer<typeof ImageJobState>;

/** `<id>/status.json` as the job writes it. */
export const ImageJobStatusFile = z.object({
	id: ImageJobId,
	kind: ImageJobKind,
	/** Never `queued`: the file exists only once the job has taken the request. */
	state: ImageJobState.exclude(["queued"]),
	/** One short sentence for the page, such as "Downloading" or "Checking health". */
	step: z.string().max(200),
	/** The image the job is about: fetched, built, activated, or rolled back to. Null until known. */
	version: ImageVersion.nullable(),
	/** Why it failed or was refused, in one sentence; null otherwise. */
	message: z.string().max(1000).nullable(),
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
});
export type ImageJobStatusFile = z.infer<typeof ImageJobStatusFile>;

/** `images/aliases.json`. */
export const ImageAliasesFile = z.object({
	default: ImageVersion.nullable(),
	previous: ImageVersion.nullable(),
});
export type ImageAliasesFile = z.infer<typeof ImageAliasesFile>;

/** The tools the manifest names by version (ruling 24); null when the tool is missing. */
export const IMAGE_TOOLS = [
	"node",
	"npm",
	"python3",
	"git",
	"docker",
	"claude",
	"codex",
] as const;
export type ImageTool = (typeof IMAGE_TOOLS)[number];

const ToolVersion = z.string().max(200).nullable();

/** `images/<version>/manifest.json` (ruling 24). */
export const ImageManifest = z.object({
	schema: z.literal(1),
	version: ImageVersion,
	/** The recipe's `VERSION` file the image was built from. */
	recipeVersion: z.string().min(1).max(100),
	source: z.enum(["published", "local"]),
	builtAt: z.string().datetime(),
	/** The Incus fingerprint, which workspaces record; the job adds it after import. */
	fingerprint: z
		.string()
		.regex(/^[0-9a-f]{12,64}$/)
		.nullable(),
	parameters: z.object({ node: ImageNodeChoice, python: ImagePythonChoice }),
	/** Each tool's `--version` output, trimmed to one line. */
	tools: z.object({
		node: ToolVersion,
		npm: ToolVersion,
		python3: ToolVersion,
		git: ToolVersion,
		docker: ToolVersion,
		claude: ToolVersion,
		codex: ToolVersion,
	}),
	/** `dpkg-query -W -f '${binary:Package}\t${Version}\n'`, as package to version. */
	packages: z.record(z.string().min(1).max(200), z.string().max(200)),
});
export type ImageManifest = z.infer<typeof ImageManifest>;

/** `images/<version>/health.json` (ruling 26). */
export const ImageHealth = z.object({
	result: z.enum(["passed", "failed"]),
	checkedAt: z.string().datetime(),
	/** One entry per command: node, python3, git, docker info, claude, codex. */
	checks: z.array(
		z.object({
			name: z.string().min(1).max(100),
			ok: z.boolean(),
			/** The first line of output or of the error. */
			output: z.string().max(500),
		}),
	),
});
export type ImageHealth = z.infer<typeof ImageHealth>;

// ---- API responses ----

export const ImageJobView = z.object({
	id: ImageJobId,
	kind: ImageJobKind,
	state: ImageJobState,
	step: z.string(),
	version: ImageVersion.nullable(),
	message: z.string().nullable(),
	requestedAt: z.string().nullable(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	/** What was asked, for the page to name it. */
	request: ImageJobRequest.nullable(),
});
export type ImageJobView = z.infer<typeof ImageJobView>;

export const ImageView = z.object({
	version: ImageVersion,
	role: z.enum(["default", "previous", "candidate"]),
	/** Null when the manifest is missing or does not parse. */
	manifest: ImageManifest.omit({ packages: true })
		.extend({ packageCount: z.number().int().nonnegative() })
		.nullable(),
	/** Null until the job has checked it. */
	health: ImageHealth.nullable(),
	/** Workspaces whose root was made from this image. */
	workspaces: z.number().int().nonnegative(),
});
export type ImageView = z.infer<typeof ImageView>;

/** `GET /admin/image`. */
export const AdminImage = z.object({
	default: ImageVersion.nullable(),
	previous: ImageVersion.nullable(),
	/** Default first, then previous, then candidates newest first. */
	images: z.array(ImageView),
	/** Workspaces on images no longer in the store, or never recorded. */
	otherWorkspaces: z.number().int().nonnegative(),
	/** The queued or running job, else the most recent one. */
	job: ImageJobView.nullable(),
});
export type AdminImage = z.infer<typeof AdminImage>;

/** `GET /admin/image/jobs/:id`. */
export const ImageJobDetail = z.object({
	job: ImageJobView,
	/** The last lines of log.txt. */
	log: z.array(z.string()),
});
export type ImageJobDetail = z.infer<typeof ImageJobDetail>;

/** How many log lines the job route answers with. */
export const IMAGE_LOG_LINES = 500;

export const ImageDiffQuery = z.object({ from: ImageVersion, to: ImageVersion });

const Entry = z.object({ name: z.string(), version: z.string().nullable() });
const Change = z.object({
	name: z.string(),
	from: z.string().nullable(),
	to: z.string().nullable(),
});
const DiffPart = z.object({
	added: z.array(Entry),
	removed: z.array(Entry),
	changed: z.array(Change),
});

/** `GET /admin/image/diff`: what `to` has that `from` does not. */
export const ImageDiff = z.object({
	from: ImageVersion,
	to: ImageVersion,
	tools: DiffPart,
	packages: DiffPart,
});
export type ImageDiff = z.infer<typeof ImageDiff>;
