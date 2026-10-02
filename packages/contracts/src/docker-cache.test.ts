/**
 * Shared Docker pull storage shapes. Seed image names reach a
 * root-run `docker pull`, so the name check is strict.
 */
import { describe, expect, test } from "vitest";
import { StartInstanceRequest } from "./controller.js";
import {
	AgentDockerInventory,
	canonicalImageName,
	DockerAdminResponse,
	DockerSettingsRequest,
	estimatedListBytes,
	HubCredentialRequest,
	IMAGE_SIZES_MAX,
	INVENTORY_IMAGES_MAX,
	isImageReference,
	isMatchedTag,
	matchingSeedImages,
	overSeedCap,
	RegistryEventEnvelope,
	RegistryJobRequestFile,
	RegistryStatusFile,
	registryEventWorkspaceIp,
	SEED_IMAGES_MAX,
	SEED_MAX_GIB_LIMIT,
	SeedBuildRequest,
	SeedImageName,
	SeedImagesRequest,
	SLIM_ESTIMATE_BYTES,
	seedDrift,
	seedImageListFor,
} from "./docker-cache.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const SHA = `sha256:${"a".repeat(64)}`;

describe("SeedImageName", () => {
	test.each([
		"python:3.12",
		"node",
		"postgres:16-alpine",
		"library/redis:7",
		"docker.io/library/alpine:3.20",
		"ghcr.io/owner/project/tool:v1.2.3",
		`alpine@${SHA}`,
		`alpine:3.20@${SHA}`,
		"my_org/some-image__x:latest",
	])("accepts %s", (name) => {
		expect(SeedImageName.safeParse(name).success).toBe(true);
	});

	test.each([
		"",
		"Python:3.12",
		"quay.io/foo/bar:1",
		"localhost/foo",
		"my.registry/foo:1",
		"localhost:5000/foo",
		"10.200.0.1:5000/foo",
		"python:3.12 ",
		" python",
		"python;rm -rf /",
		"python:$(id)",
		"-python",
		"a/b/c/d/e",
		"python:",
		":tag",
		"python:.bad",
		`alpine@sha256:${"A".repeat(64)}`,
		"alpine@sha256:abc",
		"python\n:3.12",
		`python:${"a".repeat(129)}`,
		"a".repeat(256),
	])("refuses %j", (name) => {
		expect(SeedImageName.safeParse(name).success).toBe(false);
	});
});

describe("canonicalImageName", () => {
	test.each([
		["python:3.12", "docker.io/library/python:3.12"],
		["node", "docker.io/library/node:latest"],
		["library/node", "docker.io/library/node:latest"],
		["docker.io/redis:7", "docker.io/library/redis:7"],
		["bitnami/redis", "docker.io/bitnami/redis:latest"],
		["ghcr.io/owner/tool", "ghcr.io/owner/tool:latest"],
		[`alpine@${SHA}`, `docker.io/library/alpine@${SHA}`],
		[`alpine:3@${SHA}`, `docker.io/library/alpine:3@${SHA}`],
		// Only the first registry prefix is a registry.
		["docker.io/ghcr.io/x", "docker.io/ghcr.io/x:latest"],
	])("%s is %s", (name, canonical) => {
		expect(canonicalImageName(name)).toBe(canonical);
	});
});

describe("isImageReference", () => {
	test.each([
		"redis:7",
		"docker.io/library/redis:7",
		"quay.io/org/app",
		"localhost:5000/app:dev",
		`python@${SHA}`,
	])("accepts %s", (name) => {
		expect(isImageReference(name)).toBe(true);
	});

	test.each(["Evil Name", "a/b/c/d/e/f", "x:$(id)", `x:${"t".repeat(300)}`, ""])(
		"refuses %j",
		(name) => {
			expect(isImageReference(name)).toBe(false);
		},
	);
});

describe("SeedImagesRequest", () => {
	test("accepts an empty list", () => {
		expect(SeedImagesRequest.safeParse({ images: [] }).success).toBe(true);
	});

	test("refuses the same image under two spellings", () => {
		const r = SeedImagesRequest.safeParse({
			images: ["python:3.12", "docker.io/library/python:3.12"],
		});
		expect(r.success).toBe(false);
	});

	test("refuses more than the maximum", () => {
		const images = Array.from({ length: SEED_IMAGES_MAX + 1 }, (_, i) => `img${i}:1`);
		expect(SeedImagesRequest.safeParse({ images }).success).toBe(false);
	});

	test("refuses extra fields", () => {
		expect(SeedImagesRequest.safeParse({ images: [], x: 1 }).success).toBe(false);
	});
});

describe("SeedBuildRequest", () => {
	const base = { id: ID, ghcrEnabled: false, maxBytes: 8 * 1024 ** 3 };

	test("needs at least one image", () => {
		expect(SeedBuildRequest.safeParse({ ...base, images: [] }).success).toBe(false);
		expect(SeedBuildRequest.safeParse({ ...base, images: ["node:22"] }).success).toBe(
			true,
		);
	});

	test("refuses a size cap above the limit", () => {
		const r = SeedBuildRequest.safeParse({
			...base,
			images: ["node:22"],
			maxBytes: (SEED_MAX_GIB_LIMIT + 1) * 1024 ** 3,
		});
		expect(r.success).toBe(false);
	});
});

describe("seedImageListFor", () => {
	test("refuses ghcr.io names while the ghcr cache is off", () => {
		expect(seedImageListFor(false).safeParse(["ghcr.io/o/t:1"]).success).toBe(false);
		expect(seedImageListFor(false).safeParse(["node:22"]).success).toBe(true);
	});

	test("accepts ghcr.io names while it is on", () => {
		expect(seedImageListFor(true).safeParse(["ghcr.io/o/t:1"]).success).toBe(true);
	});
});

describe("DockerSettingsRequest", () => {
	test("takes either field alone, but not neither", () => {
		expect(DockerSettingsRequest.safeParse({ ghcrEnabled: true }).success).toBe(true);
		expect(DockerSettingsRequest.safeParse({ seedMaxGiB: 4 }).success).toBe(true);
		expect(DockerSettingsRequest.safeParse({}).success).toBe(false);
	});

	test("takes the ghcr switch and a seed size cap in range", () => {
		expect(
			DockerSettingsRequest.safeParse({ ghcrEnabled: false, seedMaxGiB: 8 }).success,
		).toBe(true);
		expect(
			DockerSettingsRequest.safeParse({ ghcrEnabled: false, seedMaxGiB: 0 }).success,
		).toBe(false);
		expect(
			DockerSettingsRequest.safeParse({
				ghcrEnabled: false,
				seedMaxGiB: SEED_MAX_GIB_LIMIT + 1,
			}).success,
		).toBe(false);
	});
});

describe("DockerAdminResponse", () => {
	const answer = {
		cache: null,
		ghcrEnabled: false,
		seedMaxGiB: 8,
		hubCredential: { isSet: true },
		seedImages: ["node:22"],
		seed: null,
		imageSizes: {},
		match: null,
	};

	test("carries only whether a credential is set", () => {
		expect(DockerAdminResponse.safeParse(answer).success).toBe(true);
		const leaky = { ...answer, hubCredential: { isSet: true, username: "portikus" } };
		expect(DockerAdminResponse.safeParse(leaky).success).toBe(false);
	});
});

describe("RegistryStatusFile", () => {
	const status = {
		sizeBytes: 1,
		usedBytes: 0,
		hubUp: true,
		ghcrEnabled: false,
		ghcrUp: false,
		hubCredentialSet: false,
		lastClearedAt: null,
		lastClearReason: null,
		updatedAt: "2026-09-30T10:00:00.000Z",
	};
	const seenAt = "2026-09-30T10:00:00.000Z";

	test("an older status file still reads", () => {
		expect(RegistryStatusFile.safeParse(status).success).toBe(true);
	});

	test("takes the cache-off reason and the download sizes, capped", () => {
		const sizes = (n: number) =>
			Object.fromEntries(
				Array.from({ length: n }, (_, i) => [
					`docker.io/library/i${i}:1`,
					{ bytes: i, seenAt },
				]),
			);
		const full = {
			...status,
			cacheOff: "No room.",
			imageSizes: sizes(IMAGE_SIZES_MAX),
		};
		expect(RegistryStatusFile.safeParse(full).success).toBe(true);
		const over = { ...status, imageSizes: sizes(IMAGE_SIZES_MAX + 1) };
		expect(RegistryStatusFile.safeParse(over).success).toBe(false);
		const negative = {
			...status,
			imageSizes: { "docker.io/library/a:1": { bytes: -1, seenAt } },
		};
		expect(RegistryStatusFile.safeParse(negative).success).toBe(false);
	});
});

describe("HubCredentialRequest", () => {
	test("accepts a username and token", () => {
		expect(
			HubCredentialRequest.safeParse({
				username: "portikus",
				token: "example-token-1",
			}).success,
		).toBe(true);
	});

	test.each([
		{ username: "Portikus", token: "example-token-1" },
		{ username: "abc", token: "example-token-1" },
		{ username: "portikus", token: "short" },
		{ username: "portikus", token: "has space in it" },
		{ username: "portikus", token: "line\nbreak123" },
	])("refuses %j", (body) => {
		expect(HubCredentialRequest.safeParse(body).success).toBe(false);
	});
});

describe("RegistryJobRequestFile", () => {
	const base = { id: ID, requestedAt: "2026-09-30T12:00:00.000Z", requestedBy: ID };

	test.each([
		{ kind: "clear" },
		{ kind: "set-ghcr", enabled: true },
		{ kind: "remove-hub-credential" },
		{ kind: "set-hub-credential", username: "portikus", token: "example-token-1" },
	])("accepts %j", (request) => {
		expect(RegistryJobRequestFile.safeParse({ ...base, request }).success).toBe(true);
	});

	test.each([{ kind: "resize" }, { kind: "clear", path: "/" }, { kind: "set-ghcr" }])(
		"refuses %j",
		(request) => {
			expect(RegistryJobRequestFile.safeParse({ ...base, request }).success).toBe(
				false,
			);
		},
	);
});

describe("RegistryEventEnvelope", () => {
	test("reads a registry pull event and ignores extra fields", () => {
		const r = RegistryEventEnvelope.safeParse({
			events: [
				{
					id: "e1",
					timestamp: "2026-09-30T12:00:00Z",
					action: "pull",
					target: {
						mediaType: "application/vnd.oci.image.index.v1+json",
						repository: "library/redis",
						digest: SHA,
						tag: "7",
						url: "http://10.200.0.1:5000/v2/library/redis/manifests/7",
					},
					request: { addr: "10.200.0.23:51234", method: "GET", useragent: "docker/28" },
					source: { addr: "gateway:5000" },
				},
			],
		});
		expect(r.success).toBe(true);
	});

	const event = (repository: string, tag?: string) => ({
		events: [
			{
				id: "e1",
				timestamp: "t",
				action: "pull",
				target: { repository, tag },
				request: { addr: "10.200.0.23:1" },
			},
		],
	});

	test.each([
		["library/Redis", "7"],
		["<script>", "7"],
		["library/redis", "7 && id"],
		["a/b/c/d/e", "1"],
	])("refuses repository %j tag %j", (repo, tag) => {
		expect(RegistryEventEnvelope.safeParse(event(repo, tag)).success).toBe(false);
	});
});

describe("registryEventWorkspaceIp", () => {
	test.each([
		["10.200.0.23:51234", "10.200.0.23"],
		["10.200.0.23", "10.200.0.23"],
		["10.200.0.254:1", "10.200.0.254"],
	])("reads %s", (addr, ip) => {
		expect(registryEventWorkspaceIp(addr)).toBe(ip);
	});

	test.each([
		"10.200.0.1:5000",
		"10.200.0.0",
		"10.200.0.255",
		"10.200.1.5",
		"192.168.1.5:80",
		"10.200.0.23, 10.200.0.24",
		"10.200.0.300",
		"[::1]:80",
		"",
		"workspace",
	])("drops %j", (addr) => {
		expect(registryEventWorkspaceIp(addr)).toBeNull();
	});
});

describe("AgentDockerInventory", () => {
	test("refuses a reply past the item cap", () => {
		const images = Array.from({ length: INVENTORY_IMAGES_MAX + 1 }, () => ({
			id: SHA,
			repoTags: [],
			layers: [],
		}));
		const r = AgentDockerInventory.safeParse({
			available: true,
			images,
			containerImageIds: [],
		});
		expect(r.success).toBe(false);
	});

	test("accepts an inventory and refuses a bad layer id", () => {
		const ok = {
			available: true,
			images: [{ id: SHA, repoTags: ["python:3.12"], layers: [SHA] }],
			containerImageIds: [SHA],
		};
		expect(AgentDockerInventory.safeParse(ok).success).toBe(true);
		// An agent that sends no digests still parses.
		expect(AgentDockerInventory.parse(ok).images[0]?.repoDigests).toEqual([]);
		const bad = { ...ok, images: [{ id: SHA, repoTags: [], layers: ["nope"] }] };
		expect(AgentDockerInventory.safeParse(bad).success).toBe(false);
	});
});

describe("StartInstanceRequest docker field", () => {
	const start = {
		agentToken: "a".repeat(64),
		hostname: "ws",
		previewHostSuffix: "p.example",
		timezone: "America/New_York",
	};

	test("is optional", () => {
		expect(StartInstanceRequest.safeParse(start).success).toBe(true);
	});

	test("carries the mirror and ghcr switches", () => {
		const r = StartInstanceRequest.safeParse({
			...start,
			docker: { hubMirror: true, ghcr: false },
		});
		expect(r.success && r.data.docker).toEqual({ hubMirror: true, ghcr: false });
	});
});

describe("seed images matching the workspace image", () => {
	const manifest = (
		node: string | null,
		python3: string | null,
		python: "debian" | "uv-3.14" = "debian",
	) => ({
		parameters: { node: "24" as const, python },
		tools: {
			node,
			npm: null,
			python3,
			git: null,
			docker: null,
			claude: null,
			codex: null,
		},
	});
	const MATCH_24_313 = {
		node: { version: "24", image: "node:24-slim" },
		python: { version: "3.13", image: "python:3.13-slim" },
	};
	const MATCH_26_314 = {
		node: { version: "26", image: "node:26-slim" },
		python: { version: "3.14", image: "python:3.14-slim" },
	};

	test("Debian Python: major Node and major.minor Python from the tool versions", () => {
		expect(matchingSeedImages(manifest("v24.11.1", "Python 3.13.5"))).toEqual(
			MATCH_24_313,
		);
	});

	test("uv Python: 3.14, whatever Debian's python3 says", () => {
		expect(matchingSeedImages(manifest("v26.0.0", "Python 3.13.5", "uv-3.14"))).toEqual(
			MATCH_26_314,
		);
	});

	test("an unknown or unreadable version gives nothing for that language", () => {
		expect(matchingSeedImages(manifest(null, "something else"))).toEqual({
			node: null,
			python: null,
		});
		expect(matchingSeedImages(manifest("24", "Python 3"))).toEqual({
			node: null,
			python: null,
		});
	});

	test("matched tags are slim official images only", () => {
		expect(isMatchedTag("node:24-slim", "node")).toBe(true);
		expect(isMatchedTag("docker.io/library/python:3.13-slim", "python")).toBe(true);
		expect(isMatchedTag("node:24", "node")).toBe(false);
		expect(isMatchedTag("python:3-slim", "python")).toBe(false);
		expect(isMatchedTag("bitnami/node:24-slim", "node")).toBe(false);
	});

	test("no drift when the list holds every matched image", () => {
		expect(
			seedDrift(["redis:7", "node:24-slim", "python:3.13-slim"], MATCH_24_313),
		).toBe(null);
		expect(seedDrift([], { node: null, python: null })).toBe(null);
	});

	test("drift swaps the old matched tags for the new, keeping everything else", () => {
		expect(
			seedDrift(
				["node:24-slim", "redis:7", "python:3.13-slim", "node:22"],
				MATCH_26_314,
			),
		).toEqual({
			missing: ["node:26-slim", "python:3.14-slim"],
			old: ["node:24-slim", "python:3.13-slim"],
			next: ["redis:7", "node:22", "node:26-slim", "python:3.14-slim"],
		});
	});

	test("drift in one language leaves the other's tags alone", () => {
		expect(
			seedDrift(["node:24-slim", "python:3.12-slim", "python:3.14-slim"], MATCH_26_314),
		).toEqual({
			missing: ["node:26-slim"],
			old: ["node:24-slim"],
			next: ["python:3.12-slim", "python:3.14-slim", "node:26-slim"],
		});
	});

	test("the estimate uses known sizes, then slim estimates, else nothing", () => {
		const sizes = { "docker.io/library/redis:7": 50 };
		expect(
			estimatedListBytes(["redis:7", "node:26-slim", "python:3.14-slim", "x:1"], sizes),
		).toBe(50 + SLIM_ESTIMATE_BYTES.node + SLIM_ESTIMATE_BYTES.python);
	});

	test("over the cap when the estimate passes the limit", () => {
		const big = { "docker.io/library/redis:7": 1024 ** 3 };
		expect(overSeedCap(["redis:7", "node:26-slim"], big, 1)).toBe(true);
		expect(overSeedCap(["node:26-slim"], {}, 1)).toBe(false);
	});
});
