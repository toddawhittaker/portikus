import { z } from "zod";
import type { ImageManifest } from "./image.js";

/**
 * Shared Docker pull storage (issue #840): a pull-through registry cache on
 * the Portikus VM and one seed volume that new Docker volumes are copied
 * from. These are the shapes every part of the platform agrees on: the admin
 * API and page, the worker, the workspace controller, the workspace agent,
 * the registry's notification webhook and the root cache helper. The
 * security rulings S1 to S8 are the epic's; the fold task moves them into
 * SPEC.md section 24.
 */

// ---------------------------------------------------------------------------
// Image names
// ---------------------------------------------------------------------------

/** Registries a seed image may come from. ghcr.io only while its cache is on. */
export const SEED_REGISTRIES = ["docker.io", "ghcr.io"] as const;
export type SeedRegistry = (typeof SEED_REGISTRIES)[number];

// One path component, as the distribution reference grammar defines it.
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const TAG = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}";
const DIGEST = "sha256:[a-f0-9]{64}";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

/**
 * An image reference an administrator may put in the seed list (ruling S8):
 * first character a lowercase letter or digit, an optional `docker.io/` or
 * `ghcr.io/` prefix and no other host, no `host:port`, one to four
 * lowercase path components, an optional tag and an optional sha256 digest.
 */
export const SEED_IMAGE_PATTERN = new RegExp(
	`^(?:(?:docker\\.io|ghcr\\.io)/)?${COMPONENT}(?:/${COMPONENT}){0,3}(?::${TAG})?(?:@${DIGEST})?$`,
);

export const SEED_IMAGE_MAX_LENGTH = 255;
export const SEED_IMAGES_MAX = 30;

export const SeedImageName = z
	.string()
	.max(SEED_IMAGE_MAX_LENGTH)
	.regex(
		SEED_IMAGE_PATTERN,
		"Must be an image name such as python:3.12 or ghcr.io/owner/name:tag",
	)
	// Docker reads a dotted first part, or localhost, as a registry host.
	.refine(
		(name) => {
			const slash = name.indexOf("/");
			if (slash < 0) return true;
			const first = name.slice(0, slash);
			if ((SEED_REGISTRIES as readonly string[]).includes(first)) return true;
			return !first.includes(".") && first !== "localhost";
		},
		{ message: "Only Docker Hub and ghcr.io images may be seeded" },
	);
export type SeedImageName = z.infer<typeof SeedImageName>;

/**
 * The canonical form used to compare names from every source: registry
 * prefix, `library/` for single-component Docker Hub names, and `:latest`
 * when neither tag nor digest is given. `python:3.12` becomes
 * `docker.io/library/python:3.12`.
 */
export function canonicalImageName(name: string): string {
	let rest = name;
	let registry: SeedRegistry = "docker.io";
	for (const r of SEED_REGISTRIES) {
		if (rest.startsWith(`${r}/`)) {
			registry = r;
			rest = rest.slice(r.length + 1);
			break;
		}
	}
	const at = rest.indexOf("@");
	const digest = at >= 0 ? rest.slice(at) : "";
	let path = at >= 0 ? rest.slice(0, at) : rest;
	const colon = path.indexOf(":");
	let tag = colon >= 0 ? path.slice(colon) : "";
	if (colon >= 0) path = path.slice(0, colon);
	if (registry === "docker.io" && !path.includes("/")) path = `library/${path}`;
	if (tag === "" && digest === "") tag = ":latest";
	return `${registry}/${path}${tag}${digest}`;
}

const HOST = "(?:[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*)(?::[0-9]{1,5})?";
const IMAGE_REFERENCE = new RegExp(
	`^(?:${HOST}/)?${COMPONENT}(?:/${COMPONENT}){0,3}(?::${TAG})?(?:@${DIGEST})?$`,
);

/**
 * Whether a name from a workspace inventory fits the reference grammar the
 * webhook enforces, with any registry host allowed. Others are dropped (S7).
 */
export function isImageReference(name: string): boolean {
	return name.length <= SEED_IMAGE_MAX_LENGTH && IMAGE_REFERENCE.test(name);
}

/** The seed list as stored: valid, at most 30, no duplicates after canonicalising. */
export const SeedImageList = z
	.array(SeedImageName)
	.max(SEED_IMAGES_MAX)
	.refine((list) => new Set(list.map(canonicalImageName)).size === list.length, {
		message: "Each image may appear once",
	});
export type SeedImageList = z.infer<typeof SeedImageList>;

/**
 * The seed list an administrator may save now: ghcr.io names only while the
 * ghcr.io cache is on (ruling S8). The API, the controller and the page use it.
 */
export function seedImageListFor(ghcrEnabled: boolean) {
	return SeedImageList.refine(
		(list) => ghcrEnabled || !list.some((name) => name.startsWith("ghcr.io/")),
		{ message: "Turn on the ghcr.io cache before seeding ghcr.io images" },
	);
}

// ---------------------------------------------------------------------------
// Seed images that match the workspace image (issue #932, ruling R4)
// ---------------------------------------------------------------------------

/** The languages whose official slim images follow the workspace image. */
export const MATCHED_LANGUAGES = ["node", "python"] as const;
export type MatchedLanguage = (typeof MATCHED_LANGUAGES)[number];

/**
 * Rough download sizes of a slim image, used only when the pull cache has
 * not held it yet (issue #932: about 200 MB for Node, 130 MB for Python).
 */
export const SLIM_ESTIMATE_BYTES: Record<MatchedLanguage, number> = {
	node: 200 * 1000 ** 2,
	python: 130 * 1000 ** 2,
};

/** One language's match: the version as people say it ("24", "3.14") and its tag. */
export const MatchedImage = z.object({
	version: z.string().min(1).max(20),
	image: z.string().min(1).max(SEED_IMAGE_MAX_LENGTH),
});
export type MatchedImage = z.infer<typeof MatchedImage>;

export const SeedMatch = z.object({
	node: MatchedImage.nullable(),
	python: MatchedImage.nullable(),
});
export type SeedMatch = z.infer<typeof SeedMatch>;

/**
 * The official slim images matching an image's Node (major) and Python
 * (major.minor). With uv 3.14 the image's newest Python is 3.14; otherwise
 * Debian's `python3`. A version that cannot be read gives nothing.
 */
export function matchingSeedImages(
	manifest: Pick<ImageManifest, "parameters" | "tools">,
): SeedMatch {
	const node = /^v(\d+)\./.exec(manifest.tools.node ?? "")?.[1];
	const python =
		manifest.parameters.python === "uv-3.14"
			? "3.14"
			: /^Python (\d+\.\d+)\./.exec(manifest.tools.python3 ?? "")?.[1];
	return {
		node: node ? { version: node, image: `node:${node}-slim` } : null,
		python: python ? { version: python, image: `python:${python}-slim` } : null,
	};
}

const MATCHED_TAG: Record<MatchedLanguage, RegExp> = {
	node: /^docker\.io\/library\/node:\d+-slim$/,
	python: /^docker\.io\/library\/python:\d+\.\d+-slim$/,
};

/** Whether a seed name is a version-matched slim image for the language. */
export function isMatchedTag(name: string, language: MatchedLanguage): boolean {
	return MATCHED_TAG[language].test(canonicalImageName(name));
}

/** The matched images missing from the seed list, the old ones to drop, and the new list. */
export interface SeedDrift {
	missing: string[];
	old: string[];
	next: string[];
}

/**
 * How far `list` is from `match`, or null when it holds every matched image.
 * Only a language whose match is missing has its other matched tags
 * replaced; the rest of the list keeps its order.
 */
export function seedDrift(list: readonly string[], match: SeedMatch): SeedDrift | null {
	const has = (image: string): boolean =>
		list.some((each) => canonicalImageName(each) === canonicalImageName(image));
	const missing: string[] = [];
	const old: string[] = [];
	for (const language of MATCHED_LANGUAGES) {
		const want = match[language];
		if (!want || has(want.image)) continue;
		missing.push(want.image);
		old.push(...list.filter((each) => isMatchedTag(each, language)));
	}
	if (missing.length === 0) return null;
	return {
		missing,
		old,
		next: [...list.filter((each) => !old.includes(each)), ...missing],
	};
}

/**
 * A list's estimated download in bytes: the pull cache's size where known,
 * the slim estimate for a matched tag it has not held, else nothing.
 */
export function estimatedListBytes(
	list: readonly string[],
	sizes: Record<string, number>,
): number {
	let total = 0;
	for (const name of list) {
		const known = sizes[canonicalImageName(name)];
		if (known !== undefined) total += known;
		else if (isMatchedTag(name, "node")) total += SLIM_ESTIMATE_BYTES.node;
		else if (isMatchedTag(name, "python")) total += SLIM_ESTIMATE_BYTES.python;
	}
	return total;
}

/** Whether a list's estimated download goes past the seed's limit. */
export function overSeedCap(
	list: readonly string[],
	sizes: Record<string, number>,
	seedMaxGiB: number,
): boolean {
	return estimatedListBytes(list, sizes) > seedMaxGiB * 1024 ** 3;
}

// ---------------------------------------------------------------------------
// Fixed names, paths, ports and caps
// ---------------------------------------------------------------------------

/** The workspace bridge gateway the caches listen on (infra/ansible/site.yml). */
export const REGISTRY_GATEWAY_ADDR = "10.200.0.1";
/** The workspace bridge; a notification address outside it is dropped. */
export const WORKSPACE_BRIDGE_PREFIX = "10.200.0.";
/** Docker Hub pull-through cache, plain HTTP, set as the dockerd registry mirror. */
export const HUB_CACHE_PORT = 5000;
/** ghcr.io cache over TLS; tcp 443 to the gateway is redirected here while ghcr is on and allowed. */
export const GHCR_CACHE_PORT = 5001;
/** Upstream names the egress gate must let through for the Hub cache to work (ruling S2). */
export const HUB_UPSTREAM_NAMES = [
	"registry-1.docker.io",
	"auth.docker.io",
	"production.cloudflare.docker.com",
] as const;
/** Upstream names the egress gate must let through for the ghcr.io cache to work. */
export const GHCR_UPSTREAM_NAMES = [
	"ghcr.io",
	"pkg-containers.githubusercontent.com",
] as const;
/** Mirror URL the controller writes into each workspace's daemon.json. */
export const HUB_MIRROR_URL = `http://${REGISTRY_GATEWAY_ADDR}:${HUB_CACHE_PORT}`;

/** Path the registry posts notifications to. */
export const REGISTRY_EVENTS_PATH = "/registry/events";
/** Header carrying the webhook token on every notification (registry `notifications.endpoints[].headers`). */
export const REGISTRY_EVENTS_TOKEN_HEADER = "X-Portikus-Registry-Token";
/** Root-generated token file, readable only by the registry and worker users (ruling S7). */
export const REGISTRY_EVENTS_TOKEN_FILE = "/etc/portikus/registry/events-token";
/** Distinct image names stored per day; the rest count under `OTHER_IMAGES_LABEL` (ruling S7). */
export const REGISTRY_NAMES_PER_DAY_MAX = 2000;
export const OTHER_IMAGES_LABEL = "(other images)";

/** Custom Incus volume the seed lives in, in the workspace-data pool. */
export const SEED_VOLUME_NAME = "portikus-docker-seed";
/** Largest seed an administrator may allow (ruling S8). */
export const SEED_MAX_GIB_LIMIT = 64;

/** The cache clears itself past this share of its filesystem. */
export const REGISTRY_AUTO_CLEAR_PERCENT = 90;

/** Agent inventory caps (ruling S7): bytes of docker output read, and items returned. */
export const INVENTORY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const INVENTORY_IMAGES_MAX = 500;
export const INVENTORY_CONTAINERS_MAX = 1000;
export const INVENTORY_LAYERS_MAX = 256;
export const INVENTORY_TAGS_MAX = 50;
export const INVENTORY_DIGESTS_MAX = 50;

/** Rows the usage report returns per table, most workspaces first (ruling S7). */
export const USAGE_ROWS_MAX = 200;
/**
 * The usage report's window in calendar days, today included: about one
 * semester (issue #934). The worker keeps usage rows at least this long.
 */
export const USAGE_WINDOW_DAYS = 120;

/** Download sizes the cache helper keeps in its status file, newest first (issue #931). */
export const IMAGE_SIZES_MAX = 1000;

// ---------------------------------------------------------------------------
// Admin API: GET /admin/docker, PUT /admin/docker/settings,
// PUT|DELETE /admin/docker/hub-credential, POST /admin/docker/cache/clear,
// PUT /admin/docker/seed/images, POST|GET /admin/docker/seed/jobs,
// GET /admin/docker/usage
// ---------------------------------------------------------------------------

/**
 * `status.json` in the cache helper's job directory (env REGISTRY_JOBS_DIR),
 * written by the helper and its timer (root, 0644).
 */
export const RegistryStatusFile = z.object({
	/** Size of the cache's own filesystem, set at install. */
	sizeBytes: z.number().int().nonnegative(),
	usedBytes: z.number().int().nonnegative(),
	/** Whether the Hub cache answers on its health endpoint. */
	hubUp: z.boolean(),
	ghcrEnabled: z.boolean(),
	ghcrUp: z.boolean(),
	/** Whether a Hub credential is stored; neither its name nor its token is written here. */
	hubCredentialSet: z.boolean(),
	lastClearedAt: z.string().datetime().nullable(),
	lastClearReason: z.enum(["admin", "full", "credential"]).nullable(),
	/** Why the last clear failed; while set after a credential change the Hub cache stays stopped. */
	lastClearError: z.string().max(1000).nullable().optional(),
	/** Why setup turned the cache off for lack of disk (SPEC.md section 16.6); null while it is on. */
	cacheOff: z.string().max(300).nullable().optional(),
	/**
	 * Compressed (download) sizes of the images the caches held, by canonical
	 * name, for this host's platform, each with when the cache last held it.
	 * The helper keeps an entry 120 days, so a size outlives the cache's
	 * week-long expiry and a clear.
	 */
	imageSizes: z
		.record(
			z.string().max(SEED_IMAGE_MAX_LENGTH),
			z.object({
				bytes: z.number().int().nonnegative(),
				seenAt: z.string().datetime(),
			}),
		)
		.refine((sizes) => Object.keys(sizes).length <= IMAGE_SIZES_MAX)
		.optional(),
	updatedAt: z.string().datetime(),
});
export type RegistryStatusFile = z.infer<typeof RegistryStatusFile>;

/** The cache's status as the admin page gets it: the sizes go out per image instead. */
export const DockerCacheStatus = RegistryStatusFile.omit({ imageSizes: true });
export type DockerCacheStatus = z.infer<typeof DockerCacheStatus>;

/** The current seed, as the controller reports it (`GET /docker-seed` on the controller). */
export const SeedInfo = z.object({
	images: SeedImageList,
	sizeBytes: z.number().int().nonnegative(),
	/** Workspace image version the seed was built with; its dockerd must match. */
	imageVersion: z.string().min(1).max(100),
	builtAt: z.string().datetime(),
});
export type SeedInfo = z.infer<typeof SeedInfo>;

/** `GET /admin/docker`. `cache` is null while the helper has not written its status file. */
export const DockerAdminResponse = z.object({
	cache: DockerCacheStatus.nullable(),
	/** The saved setting; the cache follows it once the helper applies it. */
	ghcrEnabled: z.boolean(),
	seedMaxGiB: z.number().int().min(1).max(SEED_MAX_GIB_LIMIT),
	/** Only whether one is set (ruling S5). */
	hubCredential: z.object({ isSet: z.boolean() }).strict(),
	/** The list the next rebuild will use. */
	seedImages: SeedImageList,
	/** The built seed, or null when none exists yet. */
	seed: SeedInfo.nullable(),
	/**
	 * Download sizes in bytes of the images in `seedImages` and `seed`, keyed
	 * by `canonicalImageName`. An image the cache never held is missing.
	 */
	imageSizes: z.record(
		z.string().max(SEED_IMAGE_MAX_LENGTH),
		z.number().int().nonnegative(),
	),
	/**
	 * The slim images matching the default workspace image (issue #932), or
	 * null when no image manifest can be read. `imageSizes` covers them too.
	 */
	match: SeedMatch.nullable(),
});
export type DockerAdminResponse = z.infer<typeof DockerAdminResponse>;

/** `PUT /admin/docker/settings`: either field or both; a field left out keeps its value. */
export const DockerSettingsRequest = z
	.object({
		ghcrEnabled: z.boolean().optional(),
		seedMaxGiB: z.number().int().min(1).max(SEED_MAX_GIB_LIMIT).optional(),
	})
	.strict()
	.refine((b) => b.ghcrEnabled !== undefined || b.seedMaxGiB !== undefined, {
		message: "Give at least one setting",
	});
export type DockerSettingsRequest = z.infer<typeof DockerSettingsRequest>;

/**
 * `PUT /admin/docker/hub-credential`: write-only, a Docker Hub personal
 * access token with "Public Repo Read-only" scope; `DELETE` removes it.
 * Either one clears the cache (ruling S5).
 */
export const HubCredentialRequest = z
	.object({
		// Docker Hub usernames: 4 to 30 lowercase letters and digits.
		username: z.string().regex(/^[a-z0-9]{4,30}$/, "Must be a Docker Hub username"),
		// Printable ASCII only, so it cannot break the helper's YAML.
		token: z.string().regex(/^[\x21-\x7e]{8,200}$/, "Must be an access token"),
	})
	.strict();
export type HubCredentialRequest = z.infer<typeof HubCredentialRequest>;

/** `PUT /admin/docker/seed/images`. The API also checks `seedImageListFor`. */
export const SeedImagesRequest = z.object({ images: SeedImageList }).strict();
export type SeedImagesRequest = z.infer<typeof SeedImagesRequest>;

export const SeedJobState = z.enum(["queued", "running", "succeeded", "failed"]);
export type SeedJobState = z.infer<typeof SeedJobState>;

/** One seed rebuild, in `GET /admin/docker/seed/jobs` (newest first) and from `POST` (202). */
export const SeedJob = z.object({
	id: z.string().uuid(),
	state: SeedJobState,
	/** One short sentence, such as "Pulling node:22 (2 of 4)". */
	step: z.string().max(200),
	images: SeedImageList,
	message: z.string().max(1000).nullable(),
	requestedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
});
export type SeedJob = z.infer<typeof SeedJob>;

export const SeedJobsResponse = z.object({ jobs: z.array(SeedJob) });
export type SeedJobsResponse = z.infer<typeof SeedJobsResponse>;

/** One image in the usage report. Aggregate only: never names a workspace or a person. */
export const DockerImageUsage = z.object({
	/** A canonical image name, or `OTHER_IMAGES_LABEL`. Shown as text only. */
	image: z.string().max(SEED_IMAGE_MAX_LENGTH),
	/** Registry pulls in the window; 0 for an image seen only in inventories. */
	pulls: z.number().int().nonnegative(),
	workspaces: z.number().int().nonnegative(),
	lastSeen: z.string().datetime().nullable(),
	/** Download size in bytes from the pull cache, or null when the cache never held it. */
	downloadBytes: z.number().int().nonnegative().nullable(),
});
export type DockerImageUsage = z.infer<typeof DockerImageUsage>;

/** `GET /admin/docker/usage`. Each list holds at most `USAGE_ROWS_MAX` rows, most workspaces then most pulls first. */
export const DockerUsageResponse = z.object({
	windowDays: z.number().int().positive(),
	/** Pulled or present in workspaces but not in the seed. */
	notInSeed: z.array(DockerImageUsage).max(USAGE_ROWS_MAX),
	/** How many images are not in the seed, including those past the cap. */
	notInSeedTotal: z.number().int().nonnegative(),
	/** Seed images no workspace has used in the window. */
	unusedSeed: z.array(DockerImageUsage).max(USAGE_ROWS_MAX),
	unusedSeedTotal: z.number().int().nonnegative(),
});
export type DockerUsageResponse = z.infer<typeof DockerUsageResponse>;

// ---------------------------------------------------------------------------
// Worker <-> controller
// ---------------------------------------------------------------------------

/**
 * What the controller writes into a workspace before each start: the
 * daemon.json mirror, and while ghcr is on the hosts entry and certs.d CA.
 * The worker decides it from the settings and the egress policy.
 */
export const WorkspaceDockerConfig = z.object({
	hubMirror: z.boolean(),
	ghcr: z.boolean(),
});
export type WorkspaceDockerConfig = z.infer<typeof WorkspaceDockerConfig>;

/** `POST /docker-seed/builds` on the controller; 202 with `SeedBuildStatus`. */
export const SeedBuildRequest = z.object({
	id: z.string().uuid(),
	images: SeedImageList.refine((l) => l.length > 0, { message: "At least one image" }),
	/** Whether ghcr.io names are allowed; the controller re-checks with `seedImageListFor`. */
	ghcrEnabled: z.boolean(),
	/** The build fails, keeping the old seed, when the seed would be larger (ruling S8). */
	maxBytes: z
		.number()
		.int()
		.positive()
		.max(SEED_MAX_GIB_LIMIT * 1024 ** 3),
});
export type SeedBuildRequest = z.infer<typeof SeedBuildRequest>;

/** `GET /docker-seed/builds/:id` on the controller. `seed` is set once it succeeded. */
export const SeedBuildStatus = z.object({
	id: z.string().uuid(),
	state: SeedJobState.exclude(["queued"]),
	step: z.string().max(200),
	message: z.string().max(1000).nullable(),
	seed: SeedInfo.nullable(),
});
export type SeedBuildStatus = z.infer<typeof SeedBuildStatus>;

// ---------------------------------------------------------------------------
// Workspace agent: GET /docker/inventory
// ---------------------------------------------------------------------------

export const AgentDockerImage = z.object({
	id: z.string().regex(IMAGE_ID),
	repoTags: z.array(z.string().max(SEED_IMAGE_MAX_LENGTH)).max(INVENTORY_TAGS_MAX),
	/** `repository@sha256:...` names from `docker image inspect` RepoDigests. */
	repoDigests: z
		.array(z.string().max(SEED_IMAGE_MAX_LENGTH))
		.max(INVENTORY_DIGESTS_MAX)
		.default([]),
	/** Layer diff ids in order, from `docker image inspect` RootFS.Layers. */
	layers: z.array(z.string().regex(IMAGE_ID)).max(INVENTORY_LAYERS_MAX),
});
export type AgentDockerImage = z.infer<typeof AgentDockerImage>;

/**
 * The student's images and the image ids every container (running or not)
 * uses. The worker treats a reply that fails this schema as no data.
 */
export const AgentDockerInventory = z.object({
	/** False when dockerd did not answer, timed out or said too much; the lists are then empty. */
	available: z.boolean(),
	images: z.array(AgentDockerImage).max(INVENTORY_IMAGES_MAX),
	containerImageIds: z.array(z.string().regex(IMAGE_ID)).max(INVENTORY_CONTAINERS_MAX),
});
export type AgentDockerInventory = z.infer<typeof AgentDockerInventory>;

// ---------------------------------------------------------------------------
// Registry notifications webhook (docker-registry 2.8 envelope)
// ---------------------------------------------------------------------------

/**
 * One event (ruling S7). The repository and tag must match the reference
 * grammar, or the envelope is refused. Extra fields are ignored.
 */
export const RegistryEvent = z.object({
	id: z.string().max(100),
	timestamp: z.string().max(40),
	action: z.string().max(20),
	target: z.object({
		mediaType: z.string().max(200).optional(),
		repository: z
			.string()
			.max(SEED_IMAGE_MAX_LENGTH)
			.regex(new RegExp(`^${COMPONENT}(?:/${COMPONENT}){0,3}$`)),
		digest: z
			.string()
			.regex(new RegExp(`^${DIGEST}$`))
			.optional(),
		tag: z
			.string()
			.regex(new RegExp(`^${TAG}$`))
			.optional(),
	}),
	request: z.object({
		/** Where the registry says the pull came from; a hint only (`registryEventWorkspaceIp`). */
		addr: z.string().max(200),
		method: z.string().max(10).optional(),
	}),
});
export type RegistryEvent = z.infer<typeof RegistryEvent>;

export const RegistryEventEnvelope = z.object({
	events: z.array(RegistryEvent).max(1000),
});
export type RegistryEventEnvelope = z.infer<typeof RegistryEventEnvelope>;

const IPV4_WITH_PORT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/;

/**
 * The workspace bridge address an event's `addr` names, or null. `addr` can
 * carry an X-Forwarded-For value a student chose, so it is a hint only:
 * exactly one IPv4 address, with an optional port, inside the bridge and
 * not the gateway. It is never used for anything per student (ruling S7).
 */
export function registryEventWorkspaceIp(addr: string): string | null {
	const match = IPV4_WITH_PORT.exec(addr);
	if (!match) return null;
	const octets = match.slice(1, 5).map(Number);
	if (octets.some((o) => o > 255)) return null;
	const ip = octets.join(".");
	if (!ip.startsWith(WORKSPACE_BRIDGE_PREFIX)) return null;
	const last = octets[3] ?? 0;
	return last >= 2 && last <= 254 ? ip : null;
}

// ---------------------------------------------------------------------------
// Root cache helper request files (ADR 0030 pattern)
// ---------------------------------------------------------------------------

export const RegistryJobRequest = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("clear") }).strict(),
	z.object({ kind: z.literal("set-ghcr"), enabled: z.boolean() }).strict(),
	z
		.object({
			kind: z.literal("set-hub-credential"),
			username: HubCredentialRequest.shape.username,
			token: HubCredentialRequest.shape.token,
		})
		.strict(),
	z.object({ kind: z.literal("remove-hub-credential") }).strict(),
]);
export type RegistryJobRequest = z.infer<typeof RegistryJobRequest>;

/**
 * `request-<id>.json` in the job directory (env REGISTRY_JOBS_DIR), mode 0600, written as
 * `.request-<id>.tmp` then renamed; the helper deletes it before acting
 * (ruling S5).
 */
export const RegistryJobRequestFile = z.object({
	id: z.string().uuid(),
	requestedAt: z.string().datetime(),
	requestedBy: z.string().uuid(),
	request: RegistryJobRequest,
});
export type RegistryJobRequestFile = z.infer<typeof RegistryJobRequestFile>;
